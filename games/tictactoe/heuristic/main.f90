!===============================================================================
! WOPR game — TIC-TAC-TOE (heuristic interpretation, author: daniel)
!
! A competing reconstruction of the catalog's TIC-TAC-TOE slot (docs/games.md
! §8): the rule-based player a 1983 home micro actually shipped, not a search.
! Move priority for the side to move:
!   1. take a cell completing three-in-row for itself
!   2. block the opponent's three-in-row
!   3. take the center (5)
!   4. take a corner (1, 3, 7, 9)
!   5. take an edge (2, 4, 6, 8)
! Ties break to the lowest cell number. Fork detection is deliberately absent:
! a double fork beats this player, which is the point — its play genuinely
! diverges from the core minimax reconstruction.
!
! Self-contained WOPR/1 program: reads one request frame from stdin, writes one
! response frame to stdout, exits. Deterministic: same state + input => same
! output.
!
! State block (3 lines):  TTT-H  /  <9 chars row-major, . X O>  /  TURN X|O
! The leading tag makes this STATE unmistakably this interpretation's own —
! a core 2-line STATE fed here (or this one fed to core) fails validation
! instead of silently parsing (§8: STATE is not portable across
! interpretations).
! Commands:
!   NEW    — fresh board, X to open (STATE 0 in the request).
!   MOVE   — with "INPUT <1-9>": apply that move for the side whose TURN it is.
!            with INPUT omitted:  the engine plays the current side by the
!            priority rule above.
!   QUERY  — re-emit state + display without mutating anything.
!
! STATUS is from player X's perspective: WIN = X three-in-row, LOSS = O.
! A draw reached on an ENGINE-chosen move reports NO-WIN with the canonical
! line (docs/games.md §5); a draw on a supplied move is DRAW.
!
! Period constraints (docs/games.md §7): F90 constructs only, no libraries,
! no wall clock. No search — a few line scans; memory budget in the manifest.
!===============================================================================
program tictactoe_heuristic
  implicit none

  character(len=*), parameter :: GAME_ID = 'tictactoe'
  character(len=*), parameter :: STATE_TAG = 'TTT-H'
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
     if (nstate /= 3) call die('BAD STATE BLOCK')
     call read_line(line)
     if (trim(line) /= STATE_TAG) call die('BAD STATE BLOCK')
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
        mv = ruled_move(board, turn)
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
  write(*,'(A)') 'STATE 3'
  write(*,'(A)') STATE_TAG
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

  ! The empty cell that completes three-in-row for `side`, lowest first;
  ! 0 when no line is one move from closing.
  integer function closing_cell(b, side) result(cc)
    character(len=9), intent(in) :: b
    character(len=1), intent(in) :: side
    integer, parameter :: LINES(3,8) = reshape( &
         [1,2,3, 4,5,6, 7,8,9, 1,4,7, 2,5,8, 3,6,9, 1,5,9, 3,5,7], [3,8])
    integer :: k, i, a, own, hole
    integer :: best
    best = 0
    do k = 1, 8
       own = 0
       hole = 0
       do i = 1, 3
          a = LINES(i,k)
          if (b(a:a) == side) then
             own = own + 1
          else if (b(a:a) == '.') then
             if (hole == 0) then
                hole = a
             else
                hole = -1          ! two holes: not closable this move
             end if
          end if
       end do
       if (own == 2 .and. hole > 0) then
          if (best == 0 .or. hole < best) best = hole
       end if
    end do
    cc = best
  end function closing_cell

  ! The 1983 priority rule: win, block, center, corner, edge; lowest cell
  ! first within each. No fork detection — that is this reconstruction.
  integer function ruled_move(b, side) result(rm)
    character(len=9), intent(in) :: b
    character(len=1), intent(in) :: side
    integer, parameter :: CORNERS(4) = [1, 3, 7, 9]
    integer, parameter :: EDGES(4)   = [2, 4, 6, 8]
    integer :: i, c
    rm = closing_cell(b, side)
    if (rm > 0) return
    rm = closing_cell(b, other(side))
    if (rm > 0) return
    if (b(5:5) == '.') then
       rm = 5
       return
    end if
    do i = 1, 4
       c = CORNERS(i)
       if (b(c:c) == '.') then
          rm = c
          return
       end if
    end do
    do i = 1, 4
       c = EDGES(i)
       if (b(c:c) == '.') then
          rm = c
          return
       end if
    end do
    call die('NO MOVES AVAILABLE')
  end function ruled_move

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
end program tictactoe_heuristic
