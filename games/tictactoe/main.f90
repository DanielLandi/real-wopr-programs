!===============================================================================
! WOPR game — TIC-TAC-TOE (reference implementation)
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! State block (2 lines):   <9 chars row-major, . X O>  /  TURN X|O
! Commands:
!   NEW    — fresh board, X to open (STATE 0 in the request).
!   MOVE   — with "INPUT <1-9>": apply that move for the side whose TURN it is.
!            with INPUT omitted:  the engine (minimax) plays the current side.
!   QUERY  — re-emit state + display without mutating anything.
!
! STATUS is from player X's perspective: WIN = X three-in-row, LOSS = O.
! A draw reached on an ENGINE-chosen move reports NO-WIN with the canonical
! line — so when W.O.P.R. plays itself (repeated MOVE, no INPUT), the game
! always ends NO-WIN, per docs/games.md §5.
!
! Period constraints (docs/games.md §7): F90 constructs only, no libraries,
! no wall clock. Whole search space is 3^9; memory budget in the manifest.
!===============================================================================
program tictactoe
  implicit none

  character(len=*), parameter :: GAME_ID = 'tictactoe'
  character(len=*), parameter :: NOWIN_LINE = &
       'A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.'

  character(len=9)    :: board
  character(len=1)    :: turn
  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=64)   :: mv_str
  logical             :: has_input, engine_moved
  integer             :: nstate, mv
  character(len=8)    :: st

  board = '.........'
  turn  = 'X'
  has_input    = .false.
  engine_moved = .false.
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
     if (nstate /= 2) call die('BAD STATE BLOCK')
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
     ! fresh board already initialized; X opens
  case ('QUERY')
     ! no mutation
  case ('MOVE')
     if (outcome(board) /= 'P') call die('GAME ALREADY OVER')
     if (has_input) then
        mv = parse_move(mv_str)
        if (board(mv:mv) /= '.') call die('CELL OCCUPIED')
     else
        mv = best_move(board, turn)
        engine_moved = .true.
     end if
     board(mv:mv) = turn
     turn = other(turn)
  end select

  ! ---- status ---------------------------------------------------------------------
  select case (outcome(board))
  case ('X')
     st = 'WIN'
  case ('O')
     st = 'LOSS'
  case ('D')
     if (engine_moved) then
        st = 'NO-WIN'
     else
        st = 'DRAW'
     end if
  case default
     st = 'PLAYING'
  end select

  ! ---- response frame ----------------------------------------------------------------
  write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
  write(*,'(A)') 'STATE 2'
  write(*,'(A)') board
  write(*,'(A)') 'TURN '//turn
  write(*,'(A)') 'DISPLAY 5'
  call print_board(board)
  write(*,'(A)') 'STATUS '//trim(st)
  select case (trim(st))
  case ('WIN')
     write(*,'(A)') 'RESULT X WINS'
  case ('LOSS')
     write(*,'(A)') 'RESULT O WINS'
  case ('DRAW')
     write(*,'(A)') 'RESULT STALEMATE'
  case ('NO-WIN')
     write(*,'(A)') 'RESULT '//NOWIN_LINE
  end select
  write(*,'(A)') 'END'

contains

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

  subroutine print_board(b)
    character(len=9), intent(in) :: b
    integer :: r, o
    do r = 0, 2
       o = r * 3
       write(*,'(A)') ' '//b(o+1:o+1)//' | '//b(o+2:o+2)//' | '//b(o+3:o+3)
       if (r < 2) write(*,'(A)') '-----------'
    end do
  end subroutine print_board

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
