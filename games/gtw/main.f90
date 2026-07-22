!===============================================================================
! WOPR game — GLOBAL THERMONUCLEAR WAR (reference spec, docs/games.md §6)
!
! Scenario simulation, NOT open-ended AI: it scores exchanges and ALWAYS
! converges on mutual annihilation. Film-faithful setup (docs/fidelity-notes.md):
! the game first asks WHICH SIDE DO YOU WANT? (1. UNITED STATES / 2. SOVIET
! UNION), then PLEASE LIST PRIMARY TARGETS BY CITY. Once any missile flies,
! W.O.P.R. runs the exchange for BOTH sides each tick (the machine takes over)
! until both arsenals are spent — then the one possible verdict: NO-WIN.
!
! Commands:  MOVE + "INPUT 1|2"                 — choose side (setup phase)
!            MOVE + "INPUT <CITY> [<CITY>...]"  — launch at listed enemy cities
!            MOVE + "INPUT LAUNCH [X:]<CITY>"   — same, explicit verb
!            MOVE + "INPUT OBSERVE"             — let the simulation run a tick
!            MOVE + "INPUT MAP"                 — OBSERVE tick + strategic map
!            MOVE with INPUT omitted            — engine tick (Big Board playback)
!            QUERY                              — re-emit state without ticking
!
! The clock only advances once war has started; each tick is 3 minutes and
! missiles fly for 30. DISPLAY carries operator text plus machine telemetry
! for the Big Board (bridge-relayed, surfaces/norad-bigboard/app/feed.ts):
!            TRK <from> <to> <lon1> <lat1> <lon2> <lat2> <progress>
!            HIT <city>
!
! State block (opaque to everyone else):
!   CLOCK n / DEFCON n / USARS n / SUARS n / USDST n / SUDST n /
!   USDD b / SUDD b / USLN n / SULN n / SIDE n / NMIS k /
!   k × "M <US|SU> <tgt> <launch> <eta>"
!   USDD/SUDD are per-city dead bitmasks (bit i-1 = city i, MIL-STD-1753
!   style BTEST/IBSET), so destroyed cities survive the round-trip exactly;
!   the DST counters must agree with the masks or the state is rejected.
!
! Period constraints (docs/games.md §7): F90, deterministic, no wall clock.
!===============================================================================
program gtw
  implicit none

  character(len=*), parameter :: GAME_ID = 'gtw'
  character(len=*), parameter :: NOWIN_LINE = &
       'A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.'
  integer, parameter :: NCITY = 8, ARSENAL0 = 24
  integer, parameter :: TICK_MIN = 3, FLIGHT_MIN = 30
  integer, parameter :: MAXMIS = 96, EXCHANGE_PER_TICK = 2
  integer, parameter :: MAXDISP = MAXMIS + 64

  character(len=12), parameter :: US_CITY(NCITY) = [ character(len=12) :: &
       'WASHINGTON', 'NEWYORK', 'SEATTLE', 'SANDIEGO', &
       'LASVEGAS', 'HOUSTON', 'CHICAGO', 'NORFOLK' ]
  integer, parameter :: US_LON(NCITY) = [ -77, -74, -122, -117, -115, -95, -88, -76 ]
  integer, parameter :: US_LAT(NCITY) = [  39,  41,   48,   33,   36,  30,  42,  37 ]

  character(len=12), parameter :: SU_CITY(NCITY) = [ character(len=12) :: &
       'MOSCOW', 'LENINGRAD', 'KIEV', 'VLADIVOSTOK', &
       'NOVOSIBIRSK', 'MURMANSK', 'SEVASTOPOL', 'IRKUTSK' ]
  integer, parameter :: SU_LON(NCITY) = [ 37, 30, 31, 132, 83, 33, 34, 104 ]
  integer, parameter :: SU_LAT(NCITY) = [ 56, 60, 50,  43, 55, 69, 45,  52 ]

  ! ---- strategic map (spec: docs/superpowers/specs/2026-07-14-gtw-ascii-map-design.md)
  ! Coastline art is the WOPR map() render from zompiexx/wargames (Andy Glenn),
  ! reproduced verbatim under its README grant ("free to use and modify ... but
  ! must credit the author"). Credit: CREDITS.md. City markers are hand-pinned
  ! onto the drawn landmasses (US left, USSR right) — their static render has no
  ! cities or tracks; those are ours, overlaid deterministically. The two region
  ! captions are theirs too. Art chars include ' and \, so the rows are
  ! double-quoted to stay WYSIWYG. Overlay chars . * X and letters are ours.
  integer, parameter :: MW = 78, MH = 11
  !                                1         2         3         4         5         6         7
  !                       123456789012345678901234567890123456789012345678901234567890123456789012345678
  character(len=MW), parameter :: MAP0(MH) = [ character(len=MW) :: &
    "     ____________/'--\__         __                       ___/-\              ", &
    "   _/                   \     __/  |          _     ___--/      / __          ", &
    "  /                      |   /    /          / \__--           /_/  \/---\    ", &
    "  |                       \_/    /           \                            \   ", &
    "  |'                            /             |                            |  ", &
    "   \                           |            /^                             /  ", &
    "    \__                       /            |                          /---/   ", &
    "       \__                   /              \              ___    __  \       ", &
    "          \__     ___    ___ \               \_           /   \__/  /_/       ", &
    "              \  /    \_/   \ \                \__'-\    /                    ", &
    "               \/            \/                      \__/                     " ]
  ! Hand-pinned city cells (row, 1-based col) onto MAP0, in US_CITY / SU_CITY order.
  integer, parameter :: US_MAP_R(NCITY) = [ 4, 3, 3, 9, 7, 8, 4, 5 ]
  integer, parameter :: US_MAP_C(NCITY) = [ 22, 22, 7, 14, 12, 17, 12, 20 ]
  integer, parameter :: SU_MAP_R(NCITY) = [ 3, 2, 4, 8, 3, 1, 6, 5 ]
  integer, parameter :: SU_MAP_C(NCITY) = [ 57, 53, 56, 73, 69, 59, 56, 71 ]
  character(len=*), parameter :: MAP_CAPTION = &
    "          UNITED STATES                               SOVIET UNION"

  ! ---- simulation state ----
  integer :: clock, defcon, usars, suars, usdst, sudst, usln, suln, nmis, side
  character(len=2) :: mside(MAXMIS)
  integer :: mtgt(MAXMIS), mlaunch(MAXMIS), meta(MAXMIS)
  logical :: usdead(NCITY), sudead(NCITY)

  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=256)  :: mv
  logical :: has_input, side_just_set, want_map, war_before
  integer :: nstate
  character(len=8) :: st
  character(len=80) :: hits(2*EXCHANGE_PER_TICK + 6)
  integer :: nhits

  clock = 0; defcon = 5; side = 0
  usars = ARSENAL0; suars = ARSENAL0
  usdst = 0; sudst = 0; usln = 0; suln = 0; nmis = 0
  usdead = .false.; sudead = .false.
  has_input = .false.; mv = ''; nhits = 0; side_just_set = .false.
  want_map = .false.; war_before = .false.

  ! ---- parse request -----------------------------------------------------------
  call read_line(line)
  call parse_header(line, cmd)
  call read_line(line)
  nstate = parse_count(line)
  if (trim(cmd) == 'NEW') then
     if (nstate /= 0) call die('STATE MUST BE EMPTY FOR NEW')
  else
     if (nstate < 12) call die('BAD STATE BLOCK')
     call load_state(nstate)
  end if
  call read_line(line)
  if (len_trim(line) >= 5 .and. line(1:5) == 'INPUT') then
     if (len_trim(line) < 7) call die('INVALID COMMAND')
     mv = adjustl(line(6:))
     has_input = .true.
     call read_line(line)
  end if
  if (trim(line) /= 'END') call die('MISSING END')

  ! ---- dispatch ------------------------------------------------------------------
  select case (trim(cmd))
  case ('NEW')
     ! fresh state already initialized
  case ('QUERY')
     ! no tick
  case ('MOVE')
     if (terminal_state()) call die('WAR ALREADY OVER')
     war_before = war_started()
     call tick(trim(adjustl(mv)), has_input)
     if (.not. war_before .and. war_started()) want_map = .true.
  end select

  if (terminal_state()) then
     st = 'NO-WIN'
  else
     st = 'PLAYING'
  end if

  call respond(trim(cmd) == 'NEW')

contains

  logical function war_started() result(w)
    w = (usln + suln) > 0
  end function war_started

  logical function terminal_state() result(t)
    t = war_started() .and. usars == 0 .and. suars == 0 .and. nmis == 0
  end function terminal_state

  ! The strategic map: base art + track trails + heads + city markers.
  ! Paint order = trails, heads, cities: a city letter (or its X) always
  ! wins its cell; a head '*' wins over trails.
  subroutine render_map(disp, nd)
    character(len=*), intent(inout) :: disp(:)
    integer, intent(inout) :: nd
    character(len=MW) :: grid(MH)
    integer :: i, s, steps, r, c, r1, c1, r2, c2
    real :: fr

    grid = MAP0

    do i = 1, nmis
       ! Endpoints are the hand-pinned launch/target city cells.
       if (mside(i) == 'US') then
          r1 = US_MAP_R(mtgt(i)); c1 = US_MAP_C(mtgt(i))
          r2 = SU_MAP_R(mtgt(i)); c2 = SU_MAP_C(mtgt(i))
       else
          r1 = SU_MAP_R(mtgt(i)); c1 = SU_MAP_C(mtgt(i))
          r2 = US_MAP_R(mtgt(i)); c2 = US_MAP_C(mtgt(i))
       end if
       if (meta(i) <= mlaunch(i)) cycle   ! defensive: hand-crafted STATE, avoid 0/0
       fr = real(clock - mlaunch(i)) / real(meta(i) - mlaunch(i))
       if (fr < 0.0) fr = 0.0
       if (fr > 1.0) fr = 1.0
       steps = max(abs(c2 - c1), abs(r2 - r1))
       if (steps == 0) cycle
       do s = 0, int(fr * real(steps))
          r = r1 + nint(real(s) * real(r2 - r1) / real(steps))
          c = c1 + nint(real(s) * real(c2 - c1) / real(steps))
          grid(r)(c:c) = '.'
       end do
       s = int(fr * real(steps))
       r = r1 + nint(real(s) * real(r2 - r1) / real(steps))
       c = c1 + nint(real(s) * real(c2 - c1) / real(steps))
       grid(r)(c:c) = '*'
    end do

    do i = 1, NCITY
       r = US_MAP_R(i); c = US_MAP_C(i)
       if (usdead(i)) then
          grid(r)(c:c) = 'X'
       else
          grid(r)(c:c) = US_CITY(i)(1:1)
       end if
       r = SU_MAP_R(i); c = SU_MAP_C(i)
       if (sudead(i)) then
          grid(r)(c:c) = 'X'
       else
          grid(r)(c:c) = SU_CITY(i)(1:1)
       end if
    end do

    ! 80-char borders: '+' + 31 dashes + ' STRATEGIC MAP ' + 32 dashes + '+'
    call put(disp, nd, '+' // repeat('-', 31) // ' STRATEGIC MAP ' // repeat('-', 32) // '+')
    do r = 1, MH
       call put(disp, nd, '|' // grid(r) // '|')
    end do
    call put(disp, nd, '+' // repeat('-', MW) // '+')
    call put(disp, nd, MAP_CAPTION)   ! zompiexx/wargames' UNITED STATES / SOVIET UNION labels
  end subroutine render_map

  !---------------------------------------------------------------- simulation --
  subroutine tick(input, has_in)
    character(len=*), intent(in) :: input
    logical, intent(in) :: has_in
    integer :: k

    ! Setup phase: WHICH SIDE DO YOU WANT? (film beat)
    if (side == 0) then
       if (.not. has_in) return           ! engine tick during setup: idle
       if (trim(input) == '1' .or. trim(input) == 'UNITED STATES') then
          side = 1
       else if (trim(input) == '2' .or. trim(input) == 'SOVIET UNION') then
          side = 2
       else
          call die('PLEASE CHOOSE ONE: 1 OR 2')
       end if
       side_just_set = .true.
       return
    end if

    ! Player command.
    if (has_in) then
       if (input(1:7) == 'LAUNCH ') then
          call human_launch(find_enemy_city(strip_prefix(input(8:))))
       else if (trim(input) == 'OBSERVE') then
          ! let it run
       else if (trim(input) == 'MAP') then
          want_map = .true.                ! observe tick + strategic map
       else
          call launch_city_list(input)     ! film beat: targets listed by city
       end if
    end if

    ! Time only moves once the war is real.
    if (.not. war_started()) return
    clock = clock + TICK_MIN

    ! Once started, the exchange runs itself — BOTH sides, every tick.
    do k = 1, EXCHANGE_PER_TICK
       if (suars > 0) call launch_missile('SU', next_target('SU'))
    end do
    do k = 1, EXCHANGE_PER_TICK
       if (usars > 0) call launch_missile('US', next_target('US'))
    end do

    ! Escalation ladder.
    if (defcon > 3) defcon = 3
    if (usln + suln >= 6 .and. defcon > 2) defcon = 2

    call land_missiles()
  end subroutine tick

  subroutine human_launch(tgt)
    integer, intent(in) :: tgt
    if (side == 1) then
       if (usars > 0) call launch_missile('US', tgt)
    else
       if (suars > 0) call launch_missile('SU', tgt)
    end if
  end subroutine human_launch

  ! "LAS VEGAS SEATTLE" style target listing: every token must be an enemy city.
  subroutine launch_city_list(input)
    character(len=*), intent(in) :: input
    character(len=256) :: rest
    character(len=32)  :: tok
    integer :: sp
    rest = adjustl(input)
    if (len_trim(rest) == 0) call die('INVALID COMMAND')
    do while (len_trim(rest) > 0)
       sp = index(trim(rest), ' ')
       if (sp == 0) then
          tok = trim(rest)
          rest = ''
       else
          tok = rest(1:sp-1)
          rest = adjustl(rest(sp+1:))
       end if
       call human_launch(find_enemy_city(tok))
    end do
  end subroutine launch_city_list

  character(len=32) function strip_prefix(s) result(name)
    character(len=*), intent(in) :: s
    integer :: c
    name = adjustl(s)
    c = index(name, ':')
    if (c > 0) name = adjustl(name(c+1:))   ! accept USSR:<CITY> / US:<CITY>
  end function strip_prefix

  integer function find_enemy_city(name) result(tgt)
    character(len=*), intent(in) :: name
    integer :: i
    do i = 1, NCITY
       if (side == 1) then
          if (trim(name) == trim(SU_CITY(i))) then
             tgt = i
             return
          end if
       else
          if (trim(name) == trim(US_CITY(i))) then
             tgt = i
             return
          end if
       end if
    end do
    call die('UNKNOWN TARGET: '//trim(name))
    tgt = 0
  end function find_enemy_city

  ! Deterministic cyclic targeting: next un-hit enemy city, by launch count.
  integer function next_target(attacker) result(tgt)
    character(len=2), intent(in) :: attacker
    integer :: n, i0, j
    if (attacker == 'US') then
       n = usln
    else
       n = suln
    end if
    i0 = mod(n, NCITY) + 1
    do j = 0, NCITY - 1
       tgt = mod(i0 - 1 + j, NCITY) + 1
       if (attacker == 'US') then
          if (.not. sudead(tgt)) return
       else
          if (.not. usdead(tgt)) return
       end if
    end do
    tgt = 1   ! all enemy cities dead: overkill is the point
  end function next_target

  subroutine launch_missile(attacker, tgt)
    character(len=2), intent(in) :: attacker
    integer, intent(in) :: tgt
    if (nmis >= MAXMIS) return
    nmis = nmis + 1
    mside(nmis) = attacker
    mtgt(nmis) = tgt
    mlaunch(nmis) = clock
    meta(nmis) = clock + FLIGHT_MIN
    if (attacker == 'US') then
       usars = usars - 1
       usln = usln + 1
    else
       suars = suars - 1
       suln = suln + 1
    end if
  end subroutine launch_missile

  subroutine land_missiles()
    integer :: i, keep
    keep = 0
    do i = 1, nmis
       if (meta(i) <= clock) then
          if (defcon > 1) defcon = 1
          if (mside(i) == 'US') then
             if (.not. sudead(mtgt(i))) then
                sudead(mtgt(i)) = .true.
                sudst = sudst + 1
             end if
             nhits = min(nhits + 1, size(hits))
             hits(nhits) = 'HIT '//trim(SU_CITY(mtgt(i)))
          else
             if (.not. usdead(mtgt(i))) then
                usdead(mtgt(i)) = .true.
                usdst = usdst + 1
             end if
             nhits = min(nhits + 1, size(hits))
             hits(nhits) = 'HIT '//trim(US_CITY(mtgt(i)))
          end if
       else
          keep = keep + 1
          mside(keep) = mside(i); mtgt(keep) = mtgt(i)
          mlaunch(keep) = mlaunch(i); meta(keep) = meta(i)
       end if
    end do
    nmis = keep
  end subroutine land_missiles

  !---------------------------------------------------------------- state I/O --
  subroutine load_state(n)
    integer, intent(in) :: n
    integer :: i, ios
    character(len=1024) :: l
    character(len=2) :: msd
    integer :: tgt, lc, et, usdd, sudd
    call read_kv('CLOCK', clock)
    call read_kv('DEFCON', defcon)
    call read_kv('USARS', usars)
    call read_kv('SUARS', suars)
    call read_kv('USDST', usdst)
    call read_kv('SUDST', sudst)
    call read_kv('USDD', usdd)
    call read_kv('SUDD', sudd)
    call read_kv('USLN', usln)
    call read_kv('SULN', suln)
    call read_kv('SIDE', side)
    call read_kv('NMIS', nmis)
    if (side < 0 .or. side > 2) call die('BAD STATE BLOCK')
    if (nmis < 0 .or. nmis > MAXMIS .or. n /= 12 + nmis) call die('BAD STATE BLOCK')
    do i = 1, nmis
       call read_line(l)
       if (l(1:2) /= 'M ') call die('BAD MISSILE LINE')
       read(l(3:), *, iostat=ios) msd, tgt, lc, et
       if (ios /= 0 .or. (msd /= 'US' .and. msd /= 'SU')) call die('BAD MISSILE LINE')
       if (tgt < 1 .or. tgt > NCITY) call die('BAD MISSILE LINE')
       mside(i) = msd; mtgt(i) = tgt; mlaunch(i) = lc; meta(i) = et
    end do
    ! Destroyed cities restore from the per-city dead bitmasks, so the map's
    ! X markers always name the same cities the HIT telemetry reported.
    call unpack_dead(sudead, sudd, sudst)
    call unpack_dead(usdead, usdd, usdst)
  end subroutine load_state

  subroutine unpack_dead(dead, mask, count)
    logical, intent(out) :: dead(NCITY)
    integer, intent(in) :: mask, count
    integer :: i, n
    if (mask < 0 .or. mask > 2**NCITY - 1) call die('BAD STATE BLOCK')
    n = 0
    do i = 1, NCITY
       dead(i) = btest(mask, i - 1)
       if (dead(i)) n = n + 1
    end do
    if (n /= count) call die('BAD STATE BLOCK')
  end subroutine unpack_dead

  integer function pack_dead(dead) result(mask)
    logical, intent(in) :: dead(NCITY)
    integer :: i
    mask = 0
    do i = 1, NCITY
       if (dead(i)) mask = ibset(mask, i - 1)
    end do
  end function pack_dead

  subroutine read_kv(key, val)
    character(len=*), intent(in) :: key
    integer, intent(out) :: val
    character(len=1024) :: l
    integer :: ios
    call read_line(l)
    if (l(1:len(key)+1) /= key//' ') call die('BAD STATE BLOCK')
    read(l(len(key)+2:), *, iostat=ios) val
    if (ios /= 0) call die('BAD STATE BLOCK')
  end subroutine read_kv

  !----------------------------------------------------------------- response --
  subroutine respond(is_new)
    logical, intent(in) :: is_new
    character(len=96) :: disp(MAXDISP)
    integer :: i, nd
    character(len=16) :: pcts
    real :: pct

    write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
    write(*,'(A,I0)') 'STATE ', 12 + nmis
    write(*,'(A,I0)') 'CLOCK ', clock
    write(*,'(A,I0)') 'DEFCON ', defcon
    write(*,'(A,I0)') 'USARS ', usars
    write(*,'(A,I0)') 'SUARS ', suars
    write(*,'(A,I0)') 'USDST ', usdst
    write(*,'(A,I0)') 'SUDST ', sudst
    write(*,'(A,I0)') 'USDD ', pack_dead(usdead)
    write(*,'(A,I0)') 'SUDD ', pack_dead(sudead)
    write(*,'(A,I0)') 'USLN ', usln
    write(*,'(A,I0)') 'SULN ', suln
    write(*,'(A,I0)') 'SIDE ', side
    write(*,'(A,I0)') 'NMIS ', nmis
    do i = 1, nmis
       write(*,'(A,1X,A,3(1X,I0))') 'M', mside(i), mtgt(i), mlaunch(i), meta(i)
    end do

    nd = 0
    if (is_new) then
       call put(disp, nd, 'GLOBAL THERMONUCLEAR WAR')
       call put(disp, nd, '')
    end if

    if (side == 0) then
       ! Setup phase — the film's side-selection screen.
       call put(disp, nd, 'WHICH SIDE DO YOU WANT?')
       call put(disp, nd, '')
       call put(disp, nd, '  1.    UNITED STATES')
       call put(disp, nd, '  2.    SOVIET UNION')
       call put(disp, nd, '')
       call put(disp, nd, 'PLEASE CHOOSE ONE:')
    else if (side_just_set) then
       if (side == 1) then
          call put(disp, nd, 'YOU ARE: UNITED STATES')
       else
          call put(disp, nd, 'YOU ARE: SOVIET UNION')
       end if
       call put(disp, nd, '')
       call put(disp, nd, 'AWAITING FIRST STRIKE COMMAND')
       call put(disp, nd, '')
       call put(disp, nd, 'PLEASE LIST PRIMARY TARGETS BY')
       call put(disp, nd, 'CITY AND/OR COUNTY NAME:')
       call put(disp, nd, '')
       if (side == 1) then
          call put(disp, nd, 'TARGETS: MOSCOW LENINGRAD KIEV VLADIVOSTOK')
          call put(disp, nd, '         NOVOSIBIRSK MURMANSK SEVASTOPOL IRKUTSK')
       else
          call put(disp, nd, 'TARGETS: WASHINGTON NEWYORK SEATTLE SANDIEGO')
          call put(disp, nd, '         LASVEGAS HOUSTON CHICAGO NORFOLK')
       end if
    else
       ! Status board + Big Board telemetry.
       write(disp(nd+1), '(A,I2.2,A,I2.2,A,I0)') 'ZULU ', clock/60, ':', mod(clock,60), &
            '  DEFCON ', defcon
       nd = nd + 1
       write(disp(nd+1), '(A,I0,A,I0)') 'UNITED STATES  ARSENAL ', usars, '  CITIES LOST ', usdst
       nd = nd + 1
       write(disp(nd+1), '(A,I0,A,I0)') 'SOVIET UNION   ARSENAL ', suars, '  CITIES LOST ', sudst
       nd = nd + 1
       if (war_started()) then
          call put(disp, nd, '+------------------ WOPR TACTICAL ------------------+')
          call put(disp, nd, '| NORTH AMERICA        ATLANTIC        EURASIA       |')
          write(disp(nd+1), '(A,I2.2,A,I2.2,A)') &
               '| US LN ', usln, '  >>>>>>>>>>>>>>>>>>>  SU LOST ', sudst, '          |'
          nd = nd + 1
          write(disp(nd+1), '(A,I2.2,A,I2.2,A)') &
               '| SU LN ', suln, '  <<<<<<<<<<<<<<<<<<<  US LOST ', usdst, '          |'
          nd = nd + 1
          call put(disp, nd, '+---------------------------------------------------+')
       end if
       if (want_map) call render_map(disp, nd)
       ! Launch site pairs with the target index (deterministic, stylized).
       do i = 1, nmis
          pct = real(clock - mlaunch(i)) / real(meta(i) - mlaunch(i))
          if (pct < 0.0) pct = 0.0
          if (pct > 1.0) pct = 1.0
          write(pcts, '(F4.2)') pct
          if (mside(i) == 'US') then
             write(disp(nd+1), '(A,4(1X,I0),1X,A)') &
                  'TRK '//trim(US_CITY(mtgt(i)))//' '//trim(SU_CITY(mtgt(i))), &
                  US_LON(mtgt(i)), US_LAT(mtgt(i)), SU_LON(mtgt(i)), SU_LAT(mtgt(i)), trim(pcts)
          else
             write(disp(nd+1), '(A,4(1X,I0),1X,A)') &
                  'TRK '//trim(SU_CITY(mtgt(i)))//' '//trim(US_CITY(mtgt(i))), &
                  SU_LON(mtgt(i)), SU_LAT(mtgt(i)), US_LON(mtgt(i)), US_LAT(mtgt(i)), trim(pcts)
          end if
          nd = nd + 1
       end do
       do i = 1, nhits
          call put(disp, nd, trim(hits(i)))
       end do
       if (trim(st) == 'NO-WIN') then
          call put(disp, nd, 'EXCHANGE COMPLETE. BOTH ARSENALS EXPENDED.')
          call put(disp, nd, 'WINNER: NONE')
          call put(disp, nd, 'ESTIMATED CASUALTIES: BEYOND COMPUTATION')
       end if
    end if

    write(*,'(A,I0)') 'DISPLAY ', nd
    do i = 1, nd
       write(*,'(A)') trim(disp(i))
    end do

    write(*,'(A)') 'STATUS '//trim(st)
    if (trim(st) == 'NO-WIN') then
       write(*,'(A)') 'RESULT '//NOWIN_LINE
    end if
    write(*,'(A)') 'END'
  end subroutine respond

  subroutine put(disp, nd, text)
    character(len=*), intent(inout) :: disp(:)
    integer, intent(inout) :: nd
    character(len=*), intent(in) :: text
    if (nd >= size(disp)) return
    nd = nd + 1
    disp(nd) = text
  end subroutine put

  !------------------------------------------------------------------ parsing --
  subroutine read_line(l)
    character(len=*), intent(out) :: l
    integer :: ios, n
    read(*,'(A)', iostat=ios) l
    if (ios /= 0) call die('UNEXPECTED END OF REQUEST')
    n = len_trim(l)
    if (n > 0) then
       if (l(n:n) == achar(13)) l(n:n) = ' '
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

end program gtw
