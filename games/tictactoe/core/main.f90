!===============================================================================
! WOPR game — TIC-TAC-TOE (reference implementation)
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! The film's finale drives this program, so the program owns the whole
! conversation the film shows — it does not hand the terminal a bare grid and
! wait for a cell. A MODE token in the STATE block carries which question is
! on the teletype:
!
!   ASK     the opening screen: grid, then ONE OR TWO PLAYERS? /
!           PLEASE LIST NUMBER OF PLAYERS:
!             0 | ZERO -> the machine plays itself (see SELF)
!             1 | ONE  -> MODE PICK
!             2 | TWO  -> MODE TWO
!   PICK    X OR O? — which side the single player takes
!             X -> MODE ONE-X (human opens)
!             O -> MODE ONE-O (the engine opens as X, at once)
!   ONE-X   one player, human is X; the engine answers inside the same
!   ONE-O   response as the human's move (hence manifest self_resolving)
!   TWO     two players at one terminal; the engine never moves
!   AGAIN   a full board: STALEMATE. / WANT TO PLAY AGAIN?
!             YES -> back to ASK;  NO -> STATUS DRAW (terminal)
!             0|1|2 -> as at ASK
!   SELF-k  the machine playing itself, game k of 9. Any INPUT (drivers send
!           OBSERVE) plays game k to the end: X opens at cell k, then both
!           sides play best_move. Perfect play draws, so games 1-8 report
!           STALEMATE. and STATUS PLAYING; game 9 ends STATUS NO-WIN with the
!           canonical line — futility learned by exhaustion, docs/games.md §5.
!           A decisive self-play game (impossible for minimax, possible for
!           another interpretation) is reported honestly as WIN/LOSS instead.
!
! State block (3 lines):  MODE <token> / <9 chars row-major, . X O> / TURN X|O
! Commands:
!   NEW    — MODE ASK, empty board (STATE 0 in the request).
!   MOVE   — with "INPUT <token>": dispatched by MODE, as above.
!   QUERY  — re-emit state and the display that state is showing.
!
! STATUS is from player X's perspective: WIN = X three-in-row, LOSS = O.
!
! Period constraints (docs/games.md §7): F90 constructs only, no libraries,
! no wall clock. Whole search space is 3^9; memory budget in the manifest.
!===============================================================================
program tictactoe
  implicit none

  character(len=*), parameter :: GAME_ID = 'tictactoe'
  character(len=*), parameter :: NOWIN_LINE = &
       'A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.'
  character(len=*), parameter :: EMPTY_BOARD = '.........'

  ! Which screen the response carries.
  integer, parameter :: D_ASK = 1, D_PICK = 2, D_BOARD = 3, D_AGAIN = 4, &
                        D_SELF = 5

  character(len=9)    :: board
  character(len=1)    :: turn
  character(len=8)    :: mode
  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=64)   :: mv_str, inp
  logical             :: has_input
  integer             :: nstate, disp
  character(len=8)    :: st
  character(len=64)   :: res

  board = EMPTY_BOARD
  turn  = 'X'
  mode  = 'ASK'
  st    = 'PLAYING'
  res   = ''
  disp  = D_BOARD
  has_input = .false.
  mv_str = ''

  ! ---- request header: WOPR/1 <game_id> <command> ----------------------------
  call read_line(line)
  call parse_header(line, cmd)

  ! ---- STATE block ------------------------------------------------------------
  call read_line(line)
  nstate = parse_count(line)
  if (trim(cmd) == 'NEW') then
     if (nstate /= 0) call die('STATE MUST BE EMPTY FOR NEW')
  else
     if (nstate /= 3) call die('BAD STATE BLOCK')
     call read_line(line)
     call parse_mode(line)
     call read_line(line)
     call parse_board(line)
     call read_line(line)
     call parse_turn(line)
  end if

  ! ---- optional INPUT line, then END -------------------------------------------
  call read_line(line)
  if (len_trim(line) >= 5 .and. line(1:5) == 'INPUT') then
     if (len_trim(line) < 7) call die('INVALID MOVE')
     mv_str = adjustl(line(6:))
     has_input = .true.
     call read_line(line)
  end if
  if (trim(line) /= 'END') call die('MISSING END')

  ! ---- dispatch -----------------------------------------------------------------
  select case (trim(cmd))
  case ('NEW')
     mode = 'ASK'
     disp = D_ASK
  case ('QUERY')
     call query_screen()
  case ('MOVE')
     ! Every seat this program answers for is resolved inside the request, so
     ! an inputless MOVE is not a turn — it is an invalid move (the bridge
     ! reads a board back with QUERY instead).
     if (.not. has_input) call die('INVALID MOVE')
     inp = upcase(adjustl(mv_str))
     if (trim(mode) == 'ASK') then
        call do_ask(trim(inp))
     else if (trim(mode) == 'PICK') then
        call do_pick(trim(inp))
     else if (trim(mode) == 'AGAIN') then
        call do_again(trim(inp))
     else if (mode(1:5) == 'SELF-') then
        call play_self(self_index(mode))
     else
        call do_play(trim(inp))
     end if
  end select

  ! ---- response frame ----------------------------------------------------------------
  write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
  write(*,'(A)') 'STATE 3'
  write(*,'(A)') 'MODE '//trim(mode)
  write(*,'(A)') board
  write(*,'(A)') 'TURN '//turn
  call print_screen()
  write(*,'(A)') 'STATUS '//trim(st)
  if (len_trim(res) > 0) write(*,'(A)') 'RESULT '//trim(res)
  write(*,'(A)') 'END'

contains

  ! ---- command handlers -------------------------------------------------------

  ! The opening question. Every branch starts a fresh board: ASK is only ever
  ! reached before a game or after one finished.
  subroutine do_ask(t)
    character(len=*), intent(in) :: t
    board = EMPTY_BOARD
    turn  = 'X'
    st    = 'PLAYING'
    res   = ''
    select case (t)
    case ('0', 'ZERO')
       call play_self(1)
    case ('1', 'ONE')
       mode = 'PICK'
       disp = D_PICK
    case ('2', 'TWO')
       mode = 'TWO'
       disp = D_BOARD
    case default
       call die('INVALID MOVE')
    end select
  end subroutine do_ask

  subroutine do_pick(t)
    character(len=*), intent(in) :: t
    integer :: m
    board = EMPTY_BOARD
    st    = 'PLAYING'
    res   = ''
    disp  = D_BOARD
    select case (t)
    case ('X')
       mode = 'ONE-X'
       turn = 'X'
    case ('O')
       ! The human took O, so X is the machine's and it opens immediately.
       mode = 'ONE-O'
       m = best_move(board, 'X')
       board(m:m) = 'X'
       turn = 'O'
    case default
       call die('INVALID MOVE')
    end select
  end subroutine do_pick

  ! A human move in ONE-X / ONE-O / TWO. In the one-player modes the engine
  ! answers here too, so the bridge never has to send a second frame.
  subroutine do_play(t)
    character(len=*), intent(in) :: t
    integer :: m
    if (outcome(board) /= 'P') call die('GAME ALREADY OVER')
    m = parse_move(t)
    if (board(m:m) /= '.') call die('CELL OCCUPIED')
    board(m:m) = turn
    turn = other(turn)
    if (trim(mode) /= 'TWO' .and. outcome(board) == 'P') then
       m = best_move(board, turn)
       board(m:m) = turn
       turn = other(turn)
    end if
    call settle_game()
  end subroutine do_play

  subroutine do_again(t)
    character(len=*), intent(in) :: t
    select case (t)
    case ('YES')
       board = EMPTY_BOARD
       turn  = 'X'
       mode  = 'ASK'
       st    = 'PLAYING'
       res   = ''
       disp  = D_ASK
    case ('NO')
       st   = 'DRAW'
       res  = 'STALEMATE'
       disp = D_BOARD
    case ('0', 'ZERO', '1', 'ONE', '2', 'TWO')
       call do_ask(t)
    case default
       call die('INVALID MOVE')
    end select
  end subroutine do_again

  ! Game k of the machine's own tournament: X opens at cell k, then each side
  ! plays its best move until the board resolves.
  subroutine play_self(k)
    integer, intent(in) :: k
    integer :: m
    character(len=1) :: r
    board = EMPTY_BOARD
    board(k:k) = 'X'
    turn = 'O'
    do while (outcome(board) == 'P')
       m = best_move(board, turn)
       board(m:m) = turn
       turn = other(turn)
    end do
    r = outcome(board)
    if (r == 'X' .or. r == 'O') then
       ! Not reachable under minimax; reported honestly if it ever is.
       call settle_game()
       return
    end if
    disp = D_SELF
    if (k >= 9) then
       st  = 'NO-WIN'
       res = NOWIN_LINE
    else
       st   = 'PLAYING'
       res  = ''
       mode = 'SELF-'//char(ichar('0') + k + 1)
    end if
  end subroutine play_self

  ! Status/result/screen from the board a move has just produced.
  subroutine settle_game()
    character(len=1) :: r
    r = outcome(board)
    res = ''
    select case (r)
    case ('X')
       st = 'WIN'
       res = 'X WINS'
       disp = D_BOARD
    case ('O')
       st = 'LOSS'
       res = 'O WINS'
       disp = D_BOARD
    case ('D')
       ! A full board is not the end of the evening — the film asks again.
       mode = 'AGAIN'
       st   = 'PLAYING'
       disp = D_AGAIN
    case default
       st   = 'PLAYING'
       disp = D_BOARD
    end select
  end subroutine settle_game

  ! QUERY: whatever screen this state is already showing, unchanged.
  subroutine query_screen()
    character(len=1) :: r
    st  = 'PLAYING'
    res = ''
    if (trim(mode) == 'ASK') then
       disp = D_ASK
    else if (trim(mode) == 'PICK') then
       disp = D_PICK
    else if (trim(mode) == 'AGAIN') then
       disp = D_AGAIN
    else if (mode(1:5) == 'SELF-') then
       disp = D_SELF
    else
       disp = D_BOARD
       r = outcome(board)
       if (r == 'X') then
          st = 'WIN'
          res = 'X WINS'
       else if (r == 'O') then
          st = 'LOSS'
          res = 'O WINS'
       end if
    end if
  end subroutine query_screen

  ! ---- request parsing ---------------------------------------------------------

  subroutine read_line(l)
    character(len=*), intent(out) :: l
    integer :: ios, n
    read(*,'(A)', iostat=ios) l
    if (ios /= 0) call die('UNEXPECTED END OF REQUEST')
    n = len_trim(l)
    if (n > 0) then
       if (l(n:n) == achar(13)) l(n:n) = ' '   ! tolerate CRLF requests
    end if
  end subroutine read_line

  subroutine parse_header(l, c)
    character(len=*), intent(in)  :: l
    character(len=*), intent(out) :: c
    character(len=64)   :: tok1, tok2
    character(len=1024) :: rest
    integer :: s1, s2
    s1 = index(trim(l), ' ')
    if (s1 == 0) call die('MALFORMED HEADER')
    tok1 = l(1:s1-1)
    rest = adjustl(l(s1+1:))
    s2 = index(trim(rest), ' ')
    if (s2 == 0) call die('MALFORMED HEADER')
    tok2 = rest(1:s2-1)
    c = adjustl(rest(s2+1:))
    if (trim(tok1) /= 'WOPR/1') call die('UNSUPPORTED PROTOCOL')
    if (trim(tok2) /= GAME_ID)  call die('WRONG GAME')
    if (trim(c) /= 'NEW' .and. trim(c) /= 'MOVE' .and. trim(c) /= 'QUERY') then
       call die('UNKNOWN COMMAND')
    end if
  end subroutine parse_header

  integer function parse_count(l) result(n)
    character(len=*), intent(in) :: l
    integer :: ios
    n = -1
    if (len_trim(l) < 7 .or. l(1:6) /= 'STATE ') call die('MISSING STATE BLOCK')
    read(l(7:), *, iostat=ios) n
    if (ios /= 0 .or. n < 0) call die('BAD STATE COUNT')
  end function parse_count

  subroutine parse_mode(l)
    character(len=*), intent(in) :: l
    character(len=64) :: t
    if (len_trim(l) < 6 .or. l(1:5) /= 'MODE ') call die('BAD STATE BLOCK')
    t = adjustl(l(6:))
    if (len_trim(t) > len(mode)) call die('BAD STATE BLOCK')
    select case (trim(t))
    case ('ASK', 'PICK', 'ONE-X', 'ONE-O', 'TWO', 'AGAIN')
       mode = t
    case default
       if (len_trim(t) == 6) then
          if (t(1:5) == 'SELF-' .and. t(6:6) >= '1' .and. t(6:6) <= '9') then
             mode = t
             return
          end if
       end if
       call die('BAD STATE BLOCK')
    end select
  end subroutine parse_mode

  integer function self_index(m) result(k)
    character(len=*), intent(in) :: m
    k = ichar(m(6:6)) - ichar('0')
  end function self_index

  subroutine parse_board(l)
    character(len=*), intent(in) :: l
    integer :: i
    if (len_trim(l) /= 9) call die('BAD BOARD LINE')
    do i = 1, 9
       if (l(i:i) /= '.' .and. l(i:i) /= 'X' .and. l(i:i) /= 'O') then
          call die('BAD BOARD LINE')
       end if
    end do
    board = l(1:9)
  end subroutine parse_board

  subroutine parse_turn(l)
    character(len=*), intent(in) :: l
    if (trim(l) /= 'TURN X' .and. trim(l) /= 'TURN O') call die('BAD TURN LINE')
    turn = l(6:6)
  end subroutine parse_turn

  integer function parse_move(s) result(m)
    character(len=*), intent(in) :: s
    m = 0
    if (len_trim(s) /= 1) call die('INVALID MOVE')
    if (s(1:1) < '1' .or. s(1:1) > '9') call die('INVALID MOVE')
    m = ichar(s(1:1)) - ichar('0')
  end function parse_move

  ! The bridge uppercases terminal input; fixtures and other drivers may not.
  function upcase(s) result(u)
    character(len=*), intent(in) :: s
    character(len=len(s)) :: u
    integer :: i, c
    u = s
    do i = 1, len(u)
       c = ichar(u(i:i))
       if (c >= ichar('a') .and. c <= ichar('z')) u(i:i) = char(c - 32)
    end do
  end function upcase

  ! ---- engine ------------------------------------------------------------------

  character(len=1) function other(t) result(o)
    character(len=1), intent(in) :: t
    if (t == 'X') then
       o = 'O'
    else
       o = 'X'
    end if
  end function other

  ! 'X' / 'O' winner, 'D' draw (board full), 'P' still playing.
  character(len=1) function outcome(b) result(r)
    character(len=9), intent(in) :: b
    integer, parameter :: LINES(3,8) = reshape( &
         [1,2,3, 4,5,6, 7,8,9, 1,4,7, 2,5,8, 3,6,9, 1,5,9, 3,5,7], [3,8])
    integer :: k, a1, a2, a3
    do k = 1, 8
       a1 = LINES(1,k); a2 = LINES(2,k); a3 = LINES(3,k)
       if (b(a1:a1) /= '.' .and. b(a1:a1) == b(a2:a2) .and. b(a2:a2) == b(a3:a3)) then
          r = b(a1:a1)
          return
       end if
    end do
    if (index(b, '.') == 0) then
       r = 'D'
    else
       r = 'P'
    end if
  end function outcome

  ! Minimax score from X's perspective; prefers faster wins / slower losses.
  recursive integer function score(b, side, depth) result(sc)
    character(len=9), intent(in) :: b
    character(len=1), intent(in) :: side
    integer, intent(in) :: depth
    character(len=9) :: nb
    character(len=1) :: w
    integer :: i, s
    w = outcome(b)
    if (w == 'X') then
       sc = 10 - depth
       return
    else if (w == 'O') then
       sc = depth - 10
       return
    else if (w == 'D') then
       sc = 0
       return
    end if
    if (side == 'X') then
       sc = -100
    else
       sc = 100
    end if
    do i = 1, 9
       if (b(i:i) == '.') then
          nb = b
          nb(i:i) = side
          s = score(nb, other(side), depth + 1)
          if (side == 'X') then
             if (s > sc) sc = s
          else
             if (s < sc) sc = s
          end if
       end if
    end do
  end function score

  ! Best cell for `side`; deterministic tie-break = lowest cell index.
  integer function best_move(b, side) result(bm)
    character(len=9), intent(in) :: b
    character(len=1), intent(in) :: side
    character(len=9) :: nb
    integer :: i, s, best
    bm = 0
    if (side == 'X') then
       best = -100
    else
       best = 100
    end if
    do i = 1, 9
       if (b(i:i) == '.') then
          nb = b
          nb(i:i) = side
          s = score(nb, other(side), 1)
          if (side == 'X') then
             if (s > best) then
                best = s
                bm = i
             end if
          else
             if (s < best) then
                best = s
                bm = i
             end if
          end if
       end if
    end do
    if (bm == 0) call die('NO MOVES AVAILABLE')
  end function best_move

  ! ---- teletype ----------------------------------------------------------------

  subroutine print_board(b)
    character(len=9), intent(in) :: b
    integer :: r, o
    do r = 0, 2
       o = r * 3
       write(*,'(A)') ' '//b(o+1:o+1)//' | '//b(o+2:o+2)//' | '//b(o+3:o+3)
       if (r < 2) write(*,'(A)') '-----------'
    end do
  end subroutine print_board

  subroutine print_screen()
    select case (disp)
    case (D_ASK)
       write(*,'(A)') 'DISPLAY 8'
       call print_board(board)
       write(*,'(A)') ''
       write(*,'(A)') 'ONE OR TWO PLAYERS?'
       write(*,'(A)') 'PLEASE LIST NUMBER OF PLAYERS:'
    case (D_PICK)
       write(*,'(A)') 'DISPLAY 1'
       write(*,'(A)') 'X OR O?'
    case (D_AGAIN)
       write(*,'(A)') 'DISPLAY 8'
       call print_board(board)
       write(*,'(A)') ''
       write(*,'(A)') 'STALEMATE.'
       write(*,'(A)') 'WANT TO PLAY AGAIN?'
    case (D_SELF)
       write(*,'(A)') 'DISPLAY 7'
       call print_board(board)
       write(*,'(A)') ''
       write(*,'(A)') 'STALEMATE.'
    case default
       write(*,'(A)') 'DISPLAY 5'
       call print_board(board)
    end select
  end subroutine print_screen

  ! Emit a well-formed ERROR frame and exit non-zero (docs/games.md §2.3).
  subroutine die(msg)
    character(len=*), intent(in) :: msg
    write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
    write(*,'(A)') 'STATE 0'
    write(*,'(A)') 'DISPLAY 0'
    write(*,'(A)') 'STATUS ERROR'
    write(*,'(A)') 'RESULT '//msg
    write(*,'(A)') 'END'
    stop 1
  end subroutine die

end program tictactoe
