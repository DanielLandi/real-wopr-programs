!===============================================================================
! WOPR game — CHECKERS
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! Rules: standard American checkers (draughts) on the 32 dark squares,
! numbered 1-32 top-left to bottom-right (row 1 = squares 1-4). BLACK sits on
! 1-12 and moves first (down the board); WHITE sits on 21-32 and moves up.
! Captures are FORCED: when a jump exists, only jumps are legal, and a jump
! sequence must be entered in full. A man reaching the far row is crowned a
! king (crowning ends a jump sequence). Draw after 40 consecutive plies with
! no capture and no crowning.
!
! State block (3 lines):
!   <32 chars, square 1..32>   . empty, b/w men, B/W kings
!   TURN B|W
!   QUIET <n>                  plies since last capture or crowning
! Commands:
!   NEW    — opening position, BLACK to move (STATE 0 in the request).
!   MOVE   — with "INPUT <move>": apply that move for the side whose TURN it
!            is. Syntax: quiet "11-15"; jump "18X25"; multi-jump "1X10X19"
!            (every landing square, X-separated).
!            with INPUT omitted: the engine plays the current side.
!   QUERY  — re-emit state + display without mutating anything.
!
! STATUS is from BLACK's (the human's) perspective: WIN = White is out of
! pieces or moves, LOSS = Black is. A draw reached on an ENGINE-chosen ply
! reports NO-WIN with the canonical line (mirrors the tictactoe T1 ruling).
!
! Engine: depth-6 minimax with alpha-beta pruning over a material +
! advancement evaluation (man=100, king=150, +2 per row advanced for men).
! Tie-break is first-found in the fixed generation order (squares ascending,
! directions NW,NE,SW,SE) — no randomness anywhere. Alpha-beta minimax at
! this depth is comfortably 1983-plausible: Samuel's checkers program ran the
! same scheme on 1950s IBM hardware.
!
! Period constraints (docs/games.md §7): F90 constructs only, no libraries,
! no wall clock. Memory budget in the manifest.
!===============================================================================
program checkers
  implicit none

  character(len=*), parameter :: GAME_ID = 'checkers'
  character(len=*), parameter :: NOWIN_LINE = &
       'A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.'
  character(len=*), parameter :: ILLEGAL_LINE = &
       'ILLEGAL MOVE - TRY 11-15 QUIET OR 18X25 JUMP FORM'

  integer, parameter :: DEPTH  = 6      ! plies of lookahead
  integer, parameter :: MAXM   = 96     ! max legal moves held per node
  integer, parameter :: MAXP   = 14     ! max squares in one move path
  integer, parameter :: WINVAL = 30000
  integer, parameter :: DRAW_LIMIT = 40
  ! Fixed direction order: NW, NE, SW, SE (rows grow downward).
  integer, parameter :: DIR_R(4) = [-1, -1, 1, 1]
  integer, parameter :: DIR_C(4) = [-1, 1, -1, 1]

  character(len=32)   :: board
  character(len=1)    :: turn
  integer             :: quiet
  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=64)   :: mv_str
  logical             :: has_input, engine_moved
  integer             :: nstate
  character(len=8)    :: st
  character(len=1)    :: oc
  integer             :: path(MAXP), plen
  logical             :: is_jump, cap, crn
  character(len=32)   :: nb

  board = 'bbbbbbbbbbbb........wwwwwwwwwwww'
  turn  = 'B'
  quiet = 0
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
     call parse_board(line)
     call read_line(line)
     call parse_turn(line)
     call read_line(line)
     call parse_quiet(line)
  end if

  ! ---- optional INPUT line, then END -------------------------------------------
  call read_line(line)
  if (len_trim(line) >= 5 .and. line(1:5) == 'INPUT') then
     if (len_trim(line) < 7) call die(ILLEGAL_LINE)
     mv_str = adjustl(line(6:))
     has_input = .true.
     call read_line(line)
  end if
  if (trim(line) /= 'END') call die('MISSING END')

  ! ---- dispatch -----------------------------------------------------------------
  select case (trim(cmd))
  case ('NEW')
     ! opening position already initialized; BLACK opens
  case ('QUERY')
     ! no mutation
  case ('MOVE')
     if (outcome(board, turn, quiet) /= 'P') call die('GAME ALREADY OVER')
     if (has_input) then
        call parse_input(mv_str, path, plen, is_jump)
        call validate_move(board, turn, path, plen, is_jump)
     else
        call engine_move(board, turn, path, plen)
        engine_moved = .true.
     end if
     call apply_move(board, path, plen, nb, cap, crn)
     board = nb
     if (cap .or. crn) then
        quiet = 0
     else
        quiet = quiet + 1
     end if
     turn = other(turn)
  end select

  ! ---- status ---------------------------------------------------------------------
  oc = outcome(board, turn, quiet)
  select case (oc)
  case ('B')
     st = 'WIN'
  case ('W')
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
  write(*,'(A)') board
  write(*,'(A)') 'TURN '//turn
  write(*,'(A,I0)') 'QUIET ', quiet
  write(*,'(A)') 'DISPLAY 8'
  call print_board(board)
  write(*,'(A)') 'STATUS '//trim(st)
  select case (trim(st))
  case ('WIN')
     write(*,'(A)') 'RESULT BLACK WINS'
  case ('LOSS')
     write(*,'(A)') 'RESULT WHITE WINS'
  case ('DRAW')
     write(*,'(A)') 'RESULT DRAW - 40 PLIES WITHOUT CAPTURE OR CROWNING'
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
    character(len=1) :: ch
    if (len_trim(l) /= 32) call die('BAD BOARD LINE')
    do i = 1, 32
       ch = l(i:i)
       if (ch /= '.' .and. ch /= 'b' .and. ch /= 'w' .and. &
           ch /= 'B' .and. ch /= 'W') call die('BAD BOARD LINE')
    end do
    board = l(1:32)
  end subroutine parse_board

  subroutine parse_turn(l)
    character(len=*), intent(in) :: l
    if (trim(l) /= 'TURN B' .and. trim(l) /= 'TURN W') call die('BAD TURN LINE')
    turn = l(6:6)
  end subroutine parse_turn

  subroutine parse_quiet(l)
    character(len=*), intent(in) :: l
    integer :: ios
    if (len_trim(l) < 7 .or. l(1:6) /= 'QUIET ') call die('BAD QUIET LINE')
    read(l(7:), *, iostat=ios) quiet
    if (ios /= 0 .or. quiet < 0 .or. quiet > 9999) call die('BAD QUIET LINE')
  end subroutine parse_quiet

  ! ---- geometry: squares 1..32 on the dark diagonals of an 8x8 board ---------

  integer function rowof(s) result(r)
    integer, intent(in) :: s
    r = (s - 1) / 4 + 1
  end function rowof

  integer function colof(s) result(c)
    integer, intent(in) :: s
    integer :: i
    i = mod(s - 1, 4)
    if (mod(rowof(s), 2) == 1) then
       c = 2 * i + 2
    else
       c = 2 * i + 1
    end if
  end function colof

  ! Square number at (r,c), or 0 if off-board or a light square.
  integer function sqat(r, c) result(s)
    integer, intent(in) :: r, c
    s = 0
    if (r < 1 .or. r > 8 .or. c < 1 .or. c > 8) return
    if (mod(r, 2) == 1) then
       if (mod(c, 2) /= 0) return
       s = (r - 1) * 4 + (c - 2) / 2 + 1
    else
       if (mod(c, 2) /= 1) return
       s = (r - 1) * 4 + (c - 1) / 2 + 1
    end if
  end function sqat

  integer function step_sq(s, d) result(t)
    integer, intent(in) :: s, d
    t = sqat(rowof(s) + DIR_R(d), colof(s) + DIR_C(d))
  end function step_sq

  integer function jump_sq(s, d) result(t)
    integer, intent(in) :: s, d
    t = sqat(rowof(s) + 2 * DIR_R(d), colof(s) + 2 * DIR_C(d))
  end function jump_sq

  ! ---- piece predicates -------------------------------------------------------

  logical function owns(side, ch) result(o)
    character(len=1), intent(in) :: side, ch
    if (side == 'B') then
       o = (ch == 'b' .or. ch == 'B')
    else
       o = (ch == 'w' .or. ch == 'W')
    end if
  end function owns

  logical function enemy(piece, ch) result(e)
    character(len=1), intent(in) :: piece, ch
    if (piece == 'b' .or. piece == 'B') then
       e = (ch == 'w' .or. ch == 'W')
    else
       e = (ch == 'b' .or. ch == 'B')
    end if
  end function enemy

  logical function is_man(piece) result(m)
    character(len=1), intent(in) :: piece
    m = (piece == 'b' .or. piece == 'w')
  end function is_man

  ! Men move forward only; kings any diagonal. Direction order is fixed.
  logical function dir_ok(piece, d) result(o)
    character(len=1), intent(in) :: piece
    integer, intent(in) :: d
    select case (piece)
    case ('b')
       o = (DIR_R(d) == 1)
    case ('w')
       o = (DIR_R(d) == -1)
    case default
       o = .true.
    end select
  end function dir_ok

  character(len=1) function other(t) result(o)
    character(len=1), intent(in) :: t
    if (t == 'B') then
       o = 'W'
    else
       o = 'B'
    end if
  end function other

  ! ---- move generation (forced capture: jumps exist => only jumps) -----------

  subroutine record_move(pth, n, msq, mlen, nm)
    integer, intent(in)    :: pth(MAXP), n
    integer, intent(inout) :: msq(MAXP, MAXM), mlen(MAXM), nm
    if (nm >= MAXM) return
    nm = nm + 1
    msq(:, nm) = pth
    mlen(nm) = n
  end subroutine record_move

  recursive subroutine jump_dfs(wb, cur, piece, pth, n, msq, mlen, nm)
    character(len=32), intent(in) :: wb
    integer, intent(in) :: cur, n
    character(len=1), intent(in) :: piece
    integer, intent(inout) :: pth(MAXP)
    integer, intent(inout) :: msq(MAXP, MAXM), mlen(MAXM), nm
    integer :: d, mid, land
    character(len=32) :: nbb
    logical :: extended
    extended = .false.
    do d = 1, 4
       if (.not. dir_ok(piece, d)) cycle
       mid  = step_sq(cur, d)
       land = jump_sq(cur, d)
       if (mid <= 0 .or. land <= 0) cycle
       if (.not. enemy(piece, wb(mid:mid))) cycle
       if (wb(land:land) /= '.') cycle
       if (n + 1 > MAXP) cycle
       extended = .true.
       nbb = wb
       nbb(mid:mid) = '.'
       pth(n + 1) = land
       if (is_man(piece) .and. crowns(piece, land)) then
          ! crowning ends the jump sequence
          call record_move(pth, n + 1, msq, mlen, nm)
       else
          call jump_dfs(nbb, land, piece, pth, n + 1, msq, mlen, nm)
       end if
    end do
    if ((.not. extended) .and. n >= 2) call record_move(pth, n, msq, mlen, nm)
  end subroutine jump_dfs

  logical function crowns(piece, s) result(c)
    character(len=1), intent(in) :: piece
    integer, intent(in) :: s
    c = (piece == 'b' .and. rowof(s) == 8) .or. &
        (piece == 'w' .and. rowof(s) == 1)
  end function crowns

  subroutine gen_moves(b, side, msq, mlen, nm)
    character(len=32), intent(in) :: b
    character(len=1), intent(in) :: side
    integer, intent(out) :: msq(MAXP, MAXM), mlen(MAXM), nm
    integer :: s, d, t, pth(MAXP)
    character(len=32) :: wb
    nm = 0
    pth = 0
    ! jumps first — if any exist they are the only legal moves
    do s = 1, 32
       if (owns(side, b(s:s))) then
          pth(1) = s
          wb = b
          wb(s:s) = '.'
          call jump_dfs(wb, s, b(s:s), pth, 1, msq, mlen, nm)
       end if
    end do
    if (nm > 0) return
    do s = 1, 32
       if (owns(side, b(s:s))) then
          do d = 1, 4
             if (.not. dir_ok(b(s:s), d)) cycle
             t = step_sq(s, d)
             if (t <= 0) cycle
             if (b(t:t) /= '.') cycle
             pth = 0
             pth(1) = s
             pth(2) = t
             call record_move(pth, 2, msq, mlen, nm)
          end do
       end if
    end do
  end subroutine gen_moves

  subroutine apply_move(b, pth, n, nbb, captured, crowned)
    character(len=32), intent(in) :: b
    integer, intent(in) :: pth(MAXP), n
    character(len=32), intent(out) :: nbb
    logical, intent(out) :: captured, crowned
    character(len=1) :: piece
    integer :: k, mid
    nbb = b
    piece = nbb(pth(1):pth(1))
    nbb(pth(1):pth(1)) = '.'
    captured = .false.
    crowned  = .false.
    do k = 2, n
       if (abs(rowof(pth(k)) - rowof(pth(k-1))) == 2) then
          mid = sqat((rowof(pth(k)) + rowof(pth(k-1))) / 2, &
                     (colof(pth(k)) + colof(pth(k-1))) / 2)
          nbb(mid:mid) = '.'
          captured = .true.
       end if
    end do
    if (piece == 'b' .and. rowof(pth(n)) == 8) then
       piece = 'B'
       crowned = .true.
    else if (piece == 'w' .and. rowof(pth(n)) == 1) then
       piece = 'W'
       crowned = .true.
    end if
    nbb(pth(n):pth(n)) = piece
  end subroutine apply_move

  ! 'B' / 'W' winner, 'D' draw (no-progress limit), 'P' still playing.
  ! The side to move with no pieces or no legal moves loses.
  character(len=1) function outcome(b, t, q) result(r)
    character(len=32), intent(in) :: b
    character(len=1), intent(in) :: t
    integer, intent(in) :: q
    integer :: msq(MAXP, MAXM), mlen(MAXM), nm
    call gen_moves(b, t, msq, mlen, nm)
    if (nm == 0) then
       r = other(t)
    else if (q >= DRAW_LIMIT) then
       r = 'D'
    else
       r = 'P'
    end if
  end function outcome

  ! ---- evaluation + search ----------------------------------------------------

  ! Material + advancement, from BLACK's perspective.
  integer function evaluate(b) result(v)
    character(len=32), intent(in) :: b
    integer :: s
    v = 0
    do s = 1, 32
       select case (b(s:s))
       case ('b')
          v = v + 100 + 2 * (rowof(s) - 1)
       case ('B')
          v = v + 150
       case ('w')
          v = v - 100 - 2 * (8 - rowof(s))
       case ('W')
          v = v - 150
       end select
    end do
  end function evaluate

  ! Depth-limited minimax with alpha-beta, value from BLACK's perspective.
  ! Loss detection prefers faster wins / slower losses via the ply offset.
  recursive integer function absearch(b, side, depth, alpha_in, beta_in, ply) result(v)
    character(len=32), intent(in) :: b
    character(len=1), intent(in) :: side
    integer, intent(in) :: depth, alpha_in, beta_in, ply
    integer :: msq(MAXP, MAXM), mlen(MAXM), nm, k, s, alpha, beta
    character(len=32) :: nbb
    logical :: capf, crnf
    call gen_moves(b, side, msq, mlen, nm)
    if (nm == 0) then
       if (side == 'B') then
          v = -(WINVAL - ply)
       else
          v = WINVAL - ply
       end if
       return
    end if
    if (depth <= 0) then
       v = evaluate(b)
       return
    end if
    alpha = alpha_in
    beta  = beta_in
    if (side == 'B') then
       v = -2 * WINVAL
       do k = 1, nm
          call apply_move(b, msq(:, k), mlen(k), nbb, capf, crnf)
          s = absearch(nbb, 'W', depth - 1, alpha, beta, ply + 1)
          if (s > v) v = s
          if (v > alpha) alpha = v
          if (alpha >= beta) return
       end do
    else
       v = 2 * WINVAL
       do k = 1, nm
          call apply_move(b, msq(:, k), mlen(k), nbb, capf, crnf)
          s = absearch(nbb, 'B', depth - 1, alpha, beta, ply + 1)
          if (s < v) v = s
          if (v < beta) beta = v
          if (alpha >= beta) return
       end do
    end if
  end function absearch

  ! Best move for `side`; deterministic tie-break = first found in the fixed
  ! generation order (squares ascending, directions NW,NE,SW,SE).
  subroutine engine_move(b, side, bpath, bplen)
    character(len=32), intent(in) :: b
    character(len=1), intent(in) :: side
    integer, intent(out) :: bpath(MAXP), bplen
    integer :: msq(MAXP, MAXM), mlen(MAXM), nm, k, s, best, pick
    integer :: alpha, beta
    character(len=32) :: nbb
    logical :: capf, crnf
    call gen_moves(b, side, msq, mlen, nm)
    if (nm == 0) call die('NO MOVES AVAILABLE')
    alpha = -2 * WINVAL
    beta  =  2 * WINVAL
    pick = 1
    if (side == 'B') then
       best = -3 * WINVAL
       do k = 1, nm
          call apply_move(b, msq(:, k), mlen(k), nbb, capf, crnf)
          s = absearch(nbb, 'W', DEPTH - 1, alpha, beta, 1)
          if (s > best) then
             best = s
             pick = k
          end if
          if (best > alpha) alpha = best
       end do
    else
       best = 3 * WINVAL
       do k = 1, nm
          call apply_move(b, msq(:, k), mlen(k), nbb, capf, crnf)
          s = absearch(nbb, 'B', DEPTH - 1, alpha, beta, 1)
          if (s < best) then
             best = s
             pick = k
          end if
          if (best < beta) beta = best
       end do
    end if
    bpath = msq(:, pick)
    bplen = mlen(pick)
  end subroutine engine_move

  ! ---- player input -----------------------------------------------------------

  ! "11-15" (quiet, exactly two squares) or "1X10X19" (jump chain).
  subroutine parse_input(s, pth, n, isj)
    character(len=*), intent(in) :: s
    integer, intent(out) :: pth(MAXP), n
    logical, intent(out) :: isj
    integer :: i, ln, val
    logical :: innum, dash, xsep
    character(len=1) :: ch
    pth = 0
    n = 0
    val = 0
    innum = .false.
    dash = .false.
    xsep = .false.
    ln = len_trim(s)
    if (ln == 0) call die(ILLEGAL_LINE)
    do i = 1, ln
       ch = s(i:i)
       if (ch >= '0' .and. ch <= '9') then
          val = val * 10 + (ichar(ch) - ichar('0'))
          if (val > 32) call die(ILLEGAL_LINE)
          innum = .true.
       else if (ch == '-' .or. ch == 'X') then
          if (.not. innum) call die(ILLEGAL_LINE)
          call push_sq(pth, n, val)
          val = 0
          innum = .false.
          if (ch == '-') then
             dash = .true.
          else
             xsep = .true.
          end if
       else
          call die(ILLEGAL_LINE)
       end if
    end do
    if (.not. innum) call die(ILLEGAL_LINE)
    call push_sq(pth, n, val)
    if (dash .and. xsep) call die(ILLEGAL_LINE)
    if (.not. (dash .or. xsep)) call die(ILLEGAL_LINE)
    if (dash .and. n /= 2) call die(ILLEGAL_LINE)
    if (n < 2) call die(ILLEGAL_LINE)
    isj = xsep
  end subroutine parse_input

  subroutine push_sq(pth, n, val)
    integer, intent(inout) :: pth(MAXP), n
    integer, intent(in) :: val
    if (val < 1 .or. val > 32) call die(ILLEGAL_LINE)
    if (n >= MAXP) call die(ILLEGAL_LINE)
    n = n + 1
    pth(n) = val
  end subroutine push_sq

  ! The input must exactly match one generated legal move (forced capture).
  subroutine validate_move(b, side, pth, n, isj)
    character(len=32), intent(in) :: b
    character(len=1), intent(in) :: side
    integer, intent(in) :: pth(MAXP), n
    logical, intent(in) :: isj
    integer :: msq(MAXP, MAXM), mlen(MAXM), nm, k, j
    logical :: jumps_forced, match, prefix
    call gen_moves(b, side, msq, mlen, nm)
    jumps_forced = .false.
    if (nm > 0) then
       jumps_forced = (abs(rowof(msq(2, 1)) - rowof(msq(1, 1))) == 2)
    end if
    if (.not. isj) then
       if (jumps_forced) call die('CAPTURES ARE FORCED - USE THE 18X25 JUMP FORM')
    else
       if (.not. jumps_forced) call die('NO JUMP AVAILABLE - USE THE 11-15 QUIET FORM')
    end if
    do k = 1, nm
       if (mlen(k) == n) then
          match = .true.
          do j = 1, n
             if (msq(j, k) /= pth(j)) match = .false.
          end do
          if (match) return
       end if
    end do
    if (isj) then
       ! entered a true prefix of a longer forced chain?
       do k = 1, nm
          if (mlen(k) > n) then
             prefix = .true.
             do j = 1, n
                if (msq(j, k) /= pth(j)) prefix = .false.
             end do
             if (prefix) call die('MUST COMPLETE THE FULL JUMP SEQUENCE')
          end if
       end do
    end if
    call die(ILLEGAL_LINE)
  end subroutine validate_move

  ! ---- display ----------------------------------------------------------------
  ! Line-printer board, 8 lines of 32 chars: light squares '::::', empty dark
  ! squares show their number, men 'B'/'W', kings 'KB'/'KW'. Uppercase only.

  subroutine print_board(b)
    character(len=32), intent(in) :: b
    character(len=32) :: row
    character(len=4)  :: cell
    integer :: r, c, s
    do r = 1, 8
       row = ''
       do c = 1, 8
          s = sqat(r, c)
          if (s == 0) then
             cell = '::::'
          else
             select case (b(s:s))
             case ('.')
                write(cell, '(I4)') s
             case ('b')
                cell = '   B'
             case ('w')
                cell = '   W'
             case ('B')
                cell = '  KB'
             case ('W')
                cell = '  KW'
             end select
          end if
          row((c - 1) * 4 + 1:c * 4) = cell
       end do
       write(*,'(A)') row
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

end program checkers
