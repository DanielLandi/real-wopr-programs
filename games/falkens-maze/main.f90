!===============================================================================
! WOPR game — FALKEN'S MAZE (interpretation; the film only names this game)
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! Interpretation (see docs/fidelity-notes.md): a single-player text maze crawl
! in the tradition of early-80s micro games. A 12x12 perfect maze is carved by
! a depth-first backtracker (iterative, explicit stack) driven by a Park-Miller
! LCG (Schrage's method) seeded from the SEED carried in STATE. The WOPR/1
! request header takes no arguments and NEW carries no INPUT line, so every
! NEW game deals the same maze (fixed seed below) — a deliberate, documented
! choice; variety would require a wire-format change we do not make.
!
! State block (15 lines, opaque to the bridge):
!   SEED <n>          maze seed (LCG start)
!   POS <row> <col>   player cell, 1-based, row 1 = north edge
!   MOVES <n>         successful moves so far
!   <12 lines>        visited map, 12 chars each of 0/1 (fog of war)
! Commands:
!   NEW    — entrance (1,1), exit (12,12), no moves (STATE 0 in the request).
!   MOVE   — "INPUT <N|S|E|W|NORTH|SOUTH|EAST|WEST>": walk (walls refuse,
!            politely, without costing a move). "INPUT LOOK": re-describe.
!            "INPUT MAP": ASCII map of explored cells only (fog of war).
!            INPUT omitted: the engine walks one step of the shortest path
!            to the exit (BFS; unique in a perfect maze) — self-play.
!   QUERY  — re-emit state + description without mutating anything.
!
! Reaching the exit is STATUS WIN with RESULT ESCAPED IN <n> MOVES. There is
! no losing condition: a maze is a puzzle, not an opponent.
!
! Period constraints (docs/games.md §7): F77/F90 constructs only, no
! libraries, no wall clock. Park-Miller with Schrage's trick keeps every
! intermediate inside 32-bit integers, as period code had to. Memory budget
! in the manifest.
!===============================================================================
program falkensmaze
  implicit none

  character(len=*), parameter :: GAME_ID = 'falkens-maze'
  integer, parameter :: NROW = 12, NCOL = 12
  integer, parameter :: FIXED_SEED = 1983
  ! direction bits in the passage mask: set bit = open passage
  integer, parameter :: DN = 1, DS = 2, DE = 4, DW = 8

  integer :: maze(NROW,NCOL)          ! passage bitmask per cell
  logical :: visited(NROW,NCOL)
  integer :: seed, posr, posc, moves
  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=64)   :: mv_str
  logical             :: has_input
  integer             :: nstate, dirbit
  character(len=8)    :: st
  character(len=60)   :: disp(32)
  integer             :: nd, i

  has_input = .false.
  mv_str = ''
  nd = 0

  ! ---- request header: WOPR/1 <game_id> <command> ----------------------------
  call read_line(line)
  call parse_header(line, cmd)

  ! ---- STATE block ------------------------------------------------------------
  call read_line(line)
  nstate = parse_count(line)
  if (trim(cmd) == 'NEW') then
     if (nstate /= 0) call die('STATE MUST BE EMPTY FOR NEW')
     seed  = FIXED_SEED
     posr  = 1
     posc  = 1
     moves = 0
     visited = .false.
     visited(1,1) = .true.
  else
     if (nstate /= 15) call die('BAD STATE BLOCK')
     call parse_state()
  end if

  call gen_maze()

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
     call put('FALKEN''S MAZE')
     call put('A LABYRINTH OF 12 BY 12 CELLS. FIND THE WAY OUT.')
     call put(room_line())
  case ('QUERY')
     if (at_exit()) then
        call put('YOU STAND OUTSIDE THE MAZE.')
     else
        call put(room_line())
     end if
  case ('MOVE')
     if (at_exit()) call die('GAME ALREADY OVER')
     if (has_input) then
        select case (trim(mv_str))
        case ('N', 'NORTH')
           call walk(DN, 'NORTH')
        case ('S', 'SOUTH')
           call walk(DS, 'SOUTH')
        case ('E', 'EAST')
           call walk(DE, 'EAST')
        case ('W', 'WEST')
           call walk(DW, 'WEST')
        case ('LOOK')
           call put(room_line())
        case ('MAP')
           call emit_map()
        case default
           call die('INVALID MOVE')
        end select
     else
        dirbit = solve_step()
        select case (dirbit)
        case (DN)
           call walk(DN, 'NORTH')
        case (DS)
           call walk(DS, 'SOUTH')
        case (DE)
           call walk(DE, 'EAST')
        case (DW)
           call walk(DW, 'WEST')
        end select
     end if
  end select

  ! ---- status ---------------------------------------------------------------------
  if (at_exit()) then
     st = 'WIN'
  else
     st = 'PLAYING'
  end if

  ! ---- response frame ----------------------------------------------------------------
  write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
  write(*,'(A)') 'STATE 15'
  write(*,'(A,I0)') 'SEED ', seed
  write(*,'(A,I0,A,I0)') 'POS ', posr, ' ', posc
  write(*,'(A,I0)') 'MOVES ', moves
  call write_visited()
  write(*,'(A,I0)') 'DISPLAY ', nd
  do i = 1, nd
     write(*,'(A)') trim(disp(i))
  end do
  write(*,'(A)') 'STATUS '//trim(st)
  if (trim(st) == 'WIN') then
     write(*,'(A,I0,A)') 'RESULT ESCAPED IN ', moves, ' MOVES'
  end if
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

  ! Parse the 15 state lines (docs header comment); strict, dies on any damage.
  subroutine parse_state()
    character(len=1024) :: l
    integer :: ios, r, c
    call read_line(l)
    if (len_trim(l) < 6 .or. l(1:5) /= 'SEED ') call die('BAD STATE')
    read(l(6:), *, iostat=ios) seed
    if (ios /= 0 .or. seed <= 0) call die('BAD STATE')
    call read_line(l)
    if (len_trim(l) < 5 .or. l(1:4) /= 'POS ') call die('BAD STATE')
    read(l(5:), *, iostat=ios) posr, posc
    if (ios /= 0) call die('BAD STATE')
    if (posr < 1 .or. posr > NROW .or. posc < 1 .or. posc > NCOL) then
       call die('BAD STATE')
    end if
    call read_line(l)
    if (len_trim(l) < 7 .or. l(1:6) /= 'MOVES ') call die('BAD STATE')
    read(l(7:), *, iostat=ios) moves
    if (ios /= 0 .or. moves < 0) call die('BAD STATE')
    do r = 1, NROW
       call read_line(l)
       if (len_trim(l) /= NCOL) call die('BAD STATE')
       do c = 1, NCOL
          select case (l(c:c))
          case ('1')
             visited(r,c) = .true.
          case ('0')
             visited(r,c) = .false.
          case default
             call die('BAD STATE')
          end select
       end do
    end do
    if (.not. visited(posr,posc)) call die('BAD STATE')
  end subroutine parse_state

  subroutine write_visited()
    character(len=NCOL) :: vrow
    integer :: r, c
    do r = 1, NROW
       do c = 1, NCOL
          if (visited(r,c)) then
             vrow(c:c) = '1'
          else
             vrow(c:c) = '0'
          end if
       end do
       write(*,'(A)') vrow
    end do
  end subroutine write_visited

  ! Park-Miller minimal standard LCG via Schrage's method: every intermediate
  ! fits in a 32-bit signed integer (period technique, per docs/games.md §7).
  integer function lcg(s) result(t)
    integer, intent(in) :: s
    integer, parameter :: MULT = 16807, MODM = 2147483647
    integer, parameter :: QUOT = 127773, REMD = 2836
    integer :: k
    k = s / QUOT
    t = MULT * (s - k * QUOT) - REMD * k
    if (t <= 0) t = t + MODM
  end function lcg

  ! Carve a perfect maze with an iterative depth-first backtracker (explicit
  ! stack). Deterministic given the seed; neighbor order N,S,E,W.
  subroutine gen_maze()
    integer :: sr(NROW*NCOL), sc(NROW*NCOL), top
    logical :: carved(NROW,NCOL)
    integer :: dr(4), dc(4), db(4), ob(4), cand(4)
    integer :: s, r, c, k, n, r2, c2
    dr(1) = -1; dr(2) = 1; dr(3) = 0; dr(4) = 0
    dc(1) = 0;  dc(2) = 0; dc(3) = 1; dc(4) = -1
    db(1) = DN; db(2) = DS; db(3) = DE; db(4) = DW
    ob(1) = DS; ob(2) = DN; ob(3) = DW; ob(4) = DE
    maze = 0
    carved = .false.
    s = seed
    top = 1
    sr(1) = 1
    sc(1) = 1
    carved(1,1) = .true.
    do while (top > 0)
       r = sr(top)
       c = sc(top)
       n = 0
       do k = 1, 4
          r2 = r + dr(k)
          c2 = c + dc(k)
          if (r2 >= 1 .and. r2 <= NROW .and. c2 >= 1 .and. c2 <= NCOL) then
             if (.not. carved(r2,c2)) then
                n = n + 1
                cand(n) = k
             end if
          end if
       end do
       if (n == 0) then
          top = top - 1
       else
          s = lcg(s)
          k = cand(mod(s, n) + 1)
          r2 = r + dr(k)
          c2 = c + dc(k)
          maze(r,c)   = ior(maze(r,c),   db(k))
          maze(r2,c2) = ior(maze(r2,c2), ob(k))
          carved(r2,c2) = .true.
          top = top + 1
          sr(top) = r2
          sc(top) = c2
       end if
    end do
  end subroutine gen_maze

  logical function at_exit() result(a)
    a = (posr == NROW .and. posc == NCOL)
  end function at_exit

  logical function open_dir(r, c, d) result(o)
    integer, intent(in) :: r, c, d
    o = (iand(maze(r,c), d) /= 0)
  end function open_dir

  ! Attempt a step; walls refuse without costing a move.
  subroutine walk(d, dname)
    integer, intent(in) :: d
    character(len=*), intent(in) :: dname
    if (.not. open_dir(posr, posc, d)) then
       call put('A WALL BLOCKS YOUR WAY '//dname//'.')
       call put(room_line())
       return
    end if
    select case (d)
    case (DN)
       posr = posr - 1
    case (DS)
       posr = posr + 1
    case (DE)
       posc = posc + 1
    case (DW)
       posc = posc - 1
    end select
    visited(posr,posc) = .true.
    moves = moves + 1
    call put('YOU WALK '//dname//'.')
    if (at_exit()) then
       call put('DAYLIGHT AHEAD. YOU STEP OUT OF THE MAZE.')
       call put('THE PROFESSOR BUILT THIS ONE TO TEACH. WELL PLAYED.')
    else
       call put(room_line())
    end if
  end subroutine walk

  ! One step of the unique shortest path to the exit (BFS from the exit);
  ! deterministic tie-break = first open direction in N,S,E,W order.
  integer function solve_step() result(d)
    integer :: dist(NROW,NCOL), qr(NROW*NCOL), qc(NROW*NCOL)
    integer :: head, tail, r, c, r2, c2, k
    integer :: dr(4), dc(4), db(4)
    dr(1) = -1; dr(2) = 1; dr(3) = 0; dr(4) = 0
    dc(1) = 0;  dc(2) = 0; dc(3) = 1; dc(4) = -1
    db(1) = DN; db(2) = DS; db(3) = DE; db(4) = DW
    dist = -1
    dist(NROW,NCOL) = 0
    head = 1
    tail = 1
    qr(1) = NROW
    qc(1) = NCOL
    do while (head <= tail)
       r = qr(head)
       c = qc(head)
       head = head + 1
       do k = 1, 4
          if (open_dir(r, c, db(k))) then
             r2 = r + dr(k)
             c2 = c + dc(k)
             if (dist(r2,c2) < 0) then
                dist(r2,c2) = dist(r,c) + 1
                tail = tail + 1
                qr(tail) = r2
                qc(tail) = c2
             end if
          end if
       end do
    end do
    d = 0
    do k = 1, 4
       if (open_dir(posr, posc, db(k))) then
          r2 = posr + dr(k)
          c2 = posc + dc(k)
          if (dist(r2,c2) == dist(posr,posc) - 1) then
             d = db(k)
             return
          end if
       end if
    end do
    call die('NO PATH')   ! unreachable in a perfect maze
  end function solve_step

  ! Room description, one line, <= 60 chars, uppercase (teletype contract).
  character(len=60) function room_line() result(l)
    character(len=20) :: noun
    character(len=24) :: exits
    integer :: k
    if (posr == 1 .and. posc == 1) then
       noun = 'THE ENTRANCE HALL'
    else
       k = mod(posr * 7 + posc * 13, 4)
       select case (k)
       case (0)
          noun = 'A STONE PASSAGE'
       case (1)
          noun = 'A NARROW CORRIDOR'
       case (2)
          noun = 'A COLD CHAMBER'
       case (3)
          noun = 'AN ECHOING GALLERY'
       end select
    end if
    exits = ''
    if (open_dir(posr, posc, DN)) exits = trim(exits)//' NORTH'
    if (open_dir(posr, posc, DS)) exits = trim(exits)//' SOUTH'
    if (open_dir(posr, posc, DE)) exits = trim(exits)//' EAST'
    if (open_dir(posr, posc, DW)) exits = trim(exits)//' WEST'
    l = 'YOU ARE IN '//trim(noun)//'. EXITS:'//trim(exits)//'.'
  end function room_line

  logical function seen(r, c) result(v)
    integer, intent(in) :: r, c
    v = .false.
    if (r >= 1 .and. r <= NROW .and. c >= 1 .and. c <= NCOL) then
       v = visited(r,c)
    end if
  end function seen

  ! ASCII map of the explored maze (fog of war): walls render only where an
  ! adjacent cell has been visited; explored floor is '..', the player '()'.
  subroutine emit_map()
    character(len=3*NCOL+1) :: buf
    integer :: r, c, p
    call put('MAP OF THE MAZE AS EXPLORED:')
    do r = 1, NROW
       buf = ''
       do c = 1, NCOL
          p = (c - 1) * 3 + 1
          if (seen(r, c) .or. seen(r - 1, c) .or. &
              seen(r, c - 1) .or. seen(r - 1, c - 1)) buf(p:p) = '+'
          if (.not. open_dir(r, c, DN)) then
             if (seen(r, c) .or. seen(r - 1, c)) buf(p+1:p+2) = '--'
          end if
       end do
       if (seen(r, NCOL) .or. seen(r - 1, NCOL)) buf(3*NCOL+1:3*NCOL+1) = '+'
       call put(buf)
       buf = ''
       do c = 1, NCOL
          p = (c - 1) * 3 + 1
          if (.not. open_dir(r, c, DW)) then
             if (seen(r, c) .or. seen(r, c - 1)) buf(p:p) = '|'
          end if
          if (r == posr .and. c == posc) then
             buf(p+1:p+2) = '()'
          else if (visited(r,c)) then
             buf(p+1:p+2) = '..'
          end if
       end do
       if (seen(r, NCOL)) buf(3*NCOL+1:3*NCOL+1) = '|'
       call put(buf)
    end do
    buf = ''
    do c = 1, NCOL
       p = (c - 1) * 3 + 1
       if (seen(NROW, c) .or. seen(NROW, c - 1)) buf(p:p) = '+'
       if (seen(NROW, c)) buf(p+1:p+2) = '--'
    end do
    if (seen(NROW, NCOL)) buf(3*NCOL+1:3*NCOL+1) = '+'
    call put(buf)
  end subroutine emit_map

  subroutine put(l)
    character(len=*), intent(in) :: l
    nd = nd + 1
    disp(nd) = l
  end subroutine put

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

end program falkensmaze
