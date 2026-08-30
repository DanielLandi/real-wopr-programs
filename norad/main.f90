! ====================================================================
! NORAD OPERATIONS -- the operator console
!
! The program a NORAD terminal is attached to once its roster logon is
! accepted. It is the operator tier of the film: SITREP, TRACKS,
! EVENTS, SET DEFCON, and the refusal to CEASE RANDOM FUNCTION while a
! simulation is running. Joshua is not present here -- NORAD staff not
! knowing the backdoor is the plot, so anything the console does not
! recognise gets the terse machine, never conversation.
!
! The console is OBSERVATIONAL (design decision E11). It displays what
! W.O.P.R. is doing; it never attaches to a game, so it never loses its
! instruments. NEW <game> arrives here like any other line and is
! refused like one.
!
! It speaks SYSTEM/1. One request frame in, one response frame out, no
! state kept between calls. What the console cannot know for itself --
! who is logged on, the clearance floor, DEFCON, the conference, the
! link, the room's game row -- arrives in a FACTS block every turn,
! because all of it is mutable behind the console's back.
!
!   REQUEST                          RESPONSE
!   SYSTEM/1 norad INPUT             SYSTEM/1 norad OK
!   STATE <n> ...                    STATE <n> ...
!   INPUT <line>                     DISPLAY <n> ...
!   FACTS <n>                        [CALL <peer> <n> ...]
!     CALLSIGN <callsign>            LINE UP
!     CLEARANCE <1-5>                END
!     DEFCON <1-5>
!     ROOM <code|->
!     LINK <profile>
!     [GAMEROW <id> <status> <turn> <interp>]
!   [REPLY <peer> <status> <n> ...]
!   END
!
! Three things the console cannot do alone are asked of its host with a
! CALL, and the console is resumed with the REPLY:
!
!   radar    TRACKS        the radar picture of the room's running war,
!                          as card images: CLOCK, DEFCON, AC, SHIP, MSL,
!                          TARGET, EVENT (see resume_radar)
!   journal  RECENT <n>    the last n lines of the session's event log,
!                          as EVENT <kind> <actor> <summary> cards
!   defcon   SET <1-5>     change the session's DEFCON; the clearance
!                          check is made HERE, before asking
!
! The radar feed is derived by the host from the war game's own display
! (it is the same feed the Big Board renders); this console only formats
! it. Splitting radar tracking and missile warning into programs of
! their own is the JOVIAL follow-on the design records as future work.
!
! LANGUAGE. JOVIAL J73 is the historically correct language for NORAD
! command and control -- 427M at Cheyenne Mountain ran it on Honeywell
! iron -- and the design records that. No maintained J73 compiler can
! handle character data, and this console is a character program: it
! parses a line and formats a table. So it is F77/F90 Fortran within the
! pack's period discipline, like the executive that runs it, and the
! approximation is stated here rather than hidden. JOVIAL's home is the
! numeric work this console asks its host for.
! ====================================================================
program norad
   implicit none

   ! --- limits -----------------------------------------------------
   integer, parameter :: LL    = 1024   ! one card image
   integer, parameter :: MAXST = 64     ! STATE lines in or out
   integer, parameter :: MAXFC = 64     ! FACTS lines
   integer, parameter :: MAXRP = 400    ! REPLY payload lines
   integer, parameter :: MAXOU = 400    ! DISPLAY lines out
   integer, parameter :: MAXCP = 4      ! CALL payload lines
   integer, parameter :: MAXTG = 64     ! targets in the radar picture
   integer, parameter :: LASTEV = 3     ! radar events shown (the last n)
   integer, parameter :: JOURNAL_LINES = 10

   ! --- the request ------------------------------------------------
   character(len=LL) :: rq_input
   logical           :: rq_has_input
   character(len=LL) :: rp_peer, rp_status
   integer           :: rp_n
   character(len=LL) :: rp_line(MAXRP)
   logical           :: rq_has_reply

   ! --- the COMMAREA ------------------------------------------------
   character(len=LL) :: st_phase     ! continuation tag, or '-'
   character(len=LL) :: st_pa1       ! its argument, or '-'

   ! --- the facts ---------------------------------------------------
   character(len=LL) :: fc_callsign, fc_room, fc_link
   integer           :: fc_clearance, fc_defcon
   logical           :: fc_haverow
   character(len=LL) :: fc_rowid
   integer           :: fc_rowturn

   ! --- the response ------------------------------------------------
   integer           :: n_out
   character(len=LL) :: out_line(MAXOU)
   character(len=LL) :: call_peer
   integer           :: n_callp
   character(len=LL) :: call_pay(MAXCP)

   ! --- the console's voice ----------------------------------------
   character(len=*), parameter :: UNRECOGNIZED_DIRECTIVE = 'UNRECOGNIZED DIRECTIVE'
   ! The answer to CEASE RANDOM FUNCTION with a simulation running: you
   ! cannot stop it. The indentation is how it appears on screen.
   character(len=*), parameter :: CHANGES_LOCKED_OUT = '     >>> CHANGES LOCKED OUT <<<'
   character(len=*), parameter :: CEASE_RANDOM_FUNCTION = 'CEASE RANDOM FUNCTION'
   character(len=*), parameter :: CLEARANCE_DENIED = 'CLEARANCE DENIED'
   character(len=*), parameter :: NO_ACTIVE_TRACKS = 'NO ACTIVE TRACKS'
   character(len=*), parameter :: NO_TRACKS_AIRBORNE = 'NO TRACKS AIRBORNE'
   character(len=*), parameter :: NO_EVENTS_LOGGED = 'NO EVENTS LOGGED'
   character(len=*), parameter :: TRACKS_COLUMNS = &
      'ID        TYP  SIDE FROM      TO        PROG'
   ! What a failed call looks like on the teletype -- the same lines a
   ! player gets from the executive, because the console reads the war
   ! game through the same core.
   character(len=*), parameter :: CORE_TIMEOUT_TEXT = &
      'WOPR CORE UNRESPONSIVE. REQUEST TERMINATED.'
   character(len=*), parameter :: CORE_BUSY_TEXT = &
      'ALL WOPR PROCESSORS COMMITTED. STAND BY.'
   character(len=*), parameter :: IMPROPER_1 = '       ** IMPROPER REQUEST **'
   character(len=*), parameter :: IMPROPER_2 = '       ----------------------'

   call main()

contains

   subroutine main()
      call reset_state()
      call reset_facts()
      n_out = 0
      call_peer = '-'
      n_callp = 0

      call read_request()

      if (rq_has_reply) then
         call resume_call()
      else
         call take_line()
      end if

      call write_response()
   end subroutine main

   ! ================================================================
   ! Reading the request
   ! ================================================================
   subroutine read_request()
      character(len=LL) :: line
      character(len=LL) :: state_line(MAXST)
      integer :: ios, n, i

      rq_input = ' '
      rq_has_input = .false.
      rq_has_reply = .false.
      rp_peer = '-'
      rp_status = '-'
      rp_n = 0

      read(*, '(A)', iostat=ios) line
      if (ios /= 0) call protocol_error('EMPTY REQUEST')
      if (line(1:9) /= 'SYSTEM/1 ') call protocol_error('BAD HEADER')
      if (trim(word(line, 2)) /= 'norad') call protocol_error('WRONG PROGRAM')

      read(*, '(A)', iostat=ios) line
      if (ios /= 0) call protocol_error('MISSING STATE')
      if (line(1:6) /= 'STATE ') call protocol_error('MISSING STATE')
      n = to_int(word(line, 2))
      if (n < 0 .or. n > MAXST) call protocol_error('STATE OUT OF RANGE')
      do i = 1, n
         read(*, '(A)', iostat=ios) state_line(i)
         if (ios /= 0) call protocol_error('SHORT STATE BLOCK')
      end do
      call parse_state(state_line, n)

      do
         read(*, '(A)', iostat=ios) line
         if (ios /= 0) call protocol_error('MISSING END')
         if (trim(line) == 'END') exit
         if (line(1:6) == 'INPUT ') then
            rq_input = line(7:)
            rq_has_input = .true.
         else if (trim(line) == 'INPUT') then
            rq_input = ' '
            rq_has_input = .true.
         else if (line(1:6) == 'FACTS ') then
            call read_facts(to_int(word(line, 2)))
         else if (line(1:6) == 'REPLY ') then
            rp_peer = word(line, 2)
            rp_status = word(line, 3)
            rp_n = to_int(word(line, 4))
            if (rp_n < 0 .or. rp_n > MAXRP) call protocol_error('REPLY OUT OF RANGE')
            do i = 1, rp_n
               read(*, '(A)', iostat=ios) rp_line(i)
               if (ios /= 0) call protocol_error('SHORT REPLY BLOCK')
            end do
            rq_has_reply = .true.
         end if
      end do
   end subroutine read_request

   subroutine reset_state()
      st_phase = '-'
      st_pa1 = '-'
   end subroutine reset_state

   ! An empty STATE block is a line just typed: nothing pending. The
   ! only state this console ever carries is the continuation of a
   ! CALL it made this turn.
   subroutine parse_state(sl, n)
      character(len=*), intent(in) :: sl(MAXST)
      integer, intent(in) :: n
      integer :: i
      do i = 1, n
         select case (trim(word(sl(i), 1)))
         case ('PHASE')
            st_phase = word(sl(i), 2)
         case ('PA1')
            st_pa1 = word(sl(i), 2)
         end select
      end do
   end subroutine parse_state

   subroutine reset_facts()
      fc_callsign = 'UNKNOWN'
      fc_clearance = 5
      fc_defcon = 5
      fc_room = '-'
      fc_link = 'UNKNOWN'
      fc_haverow = .false.
      fc_rowid = '-'
      fc_rowturn = 0
   end subroutine reset_facts

   subroutine read_facts(n)
      integer, intent(in) :: n
      character(len=LL) :: line
      integer :: i, ios

      if (n < 0 .or. n > MAXFC) call protocol_error('FACTS OUT OF RANGE')
      do i = 1, n
         read(*, '(A)', iostat=ios) line
         if (ios /= 0) call protocol_error('SHORT FACTS BLOCK')
         select case (trim(word(line, 1)))
         case ('CALLSIGN')
            fc_callsign = word(line, 2)
         case ('CLEARANCE')
            fc_clearance = to_int(word(line, 2))
         case ('DEFCON')
            fc_defcon = to_int(word(line, 2))
         case ('ROOM')
            fc_room = word(line, 2)
         case ('LINK')
            fc_link = word(line, 2)
         case ('GAMEROW')
            fc_haverow = .true.
            fc_rowid = word(line, 2)
            fc_rowturn = to_int(word(line, 4))
         end select
      end do
   end subroutine read_facts

   ! ================================================================
   ! Taking a line
   ! ================================================================
   subroutine take_line()
      character(len=LL) :: up
      integer :: level

      up = upcase(trim(adjustl(rq_input)))

      if (trim(up) == 'SITREP') then
         call say_sitrep()
         return
      end if
      if (trim(up) == 'TRACKS') then
         ! Only a running war has a radar picture. Anything else in the
         ! room -- or nothing -- is answered without asking the host.
         if (.not. fc_haverow .or. trim(fc_rowid) /= 'gtw') then
            call emit(NO_ACTIVE_TRACKS)
            return
         end if
         call ask('radar', 'TRACKS', 'RADAR', '-')
         return
      end if
      if (trim(up) == 'EVENTS') then
         call ask('journal', 'RECENT '//trim(itoa(JOURNAL_LINES)), 'JOURNAL', '-')
         return
      end if
      if (trim(up) == CEASE_RANDOM_FUNCTION .and. fc_haverow) then
         ! The film's whole argument, at the console. The row is the
         ! room's latest game, the same view TRACKS and SITREP get, so
         ! any live simulation locks changes out -- the film had
         ! tic-tac-toe on screen while the launch routine ran, so what
         ! is displayed is beside the point. With nothing running there
         ! is nothing to cease, and the line falls through below.
         call emit(CHANGES_LOCKED_OUT)
         return
      end if
      level = defcon_level(up)
      if (level > 0) then
         ! 1 is most privileged: an operator may only command at or
         ! above their numeric floor. Decided here, before the host is
         ! asked to change anything.
         if (level < fc_clearance) then
            call emit(CLEARANCE_DENIED)
            return
         end if
         call ask('defcon', 'SET '//trim(itoa(level)), 'DEFCON', trim(itoa(level)))
         return
      end if
      call emit(UNRECOGNIZED_DIRECTIVE)
   end subroutine take_line

   ! SET DEFCON <1-5>, exactly -- one space, one digit, nothing after.
   ! Returns the level, or 0 when the line is not that directive.
   integer function defcon_level(up) result(level)
      character(len=*), intent(in) :: up
      integer :: c
      level = 0
      if (len_trim(up) /= 12) return
      if (up(1:11) /= 'SET DEFCON ') return
      c = iachar(up(12:12))
      if (c < 49 .or. c > 53) return
      level = c - 48
   end function defcon_level

   subroutine say_sitrep()
      call emit('SITREP '//trim(fc_callsign)//' LEVEL '//trim(itoa(fc_clearance)))
      call emit('DEFCON '//trim(itoa(fc_defcon)))
      if (fc_haverow) then
         call emit('SIMULATION: '//trim(upcase(fc_rowid))//' TURN '//trim(itoa(fc_rowturn)))
      else
         call emit('SIMULATION: IDLE')
      end if
      if (trim(fc_room) == '-') then
         call emit('CONFERENCE: NONE')
      else
         call emit('CONFERENCE: '//trim(fc_room))
      end if
      call emit('LINK: '//trim(upcase(fc_link)))
   end subroutine say_sitrep

   ! End this turn with a question for the host, and remember where to
   ! pick up when the answer comes back.
   subroutine ask(peer, payload, phase, pa1)
      character(len=*), intent(in) :: peer, payload, phase, pa1
      call_peer = peer
      n_callp = 1
      call_pay(1) = payload
      st_phase = phase
      st_pa1 = pa1
   end subroutine ask

   ! ================================================================
   ! Being resumed with an answer
   ! ================================================================
   subroutine resume_call()
      character(len=LL) :: phase

      phase = st_phase
      st_phase = '-'
      select case (trim(phase))
      case ('RADAR');    call resume_radar()
      case ('JOURNAL');  call resume_journal()
      case ('DEFCON');   call resume_defcon()
      case default
         call protocol_error('REPLY WITH NO CONTINUATION')
      end select
   end subroutine resume_call

   ! The radar picture, as the host sends it:
   !
   !   NONE                             the war ended between the facts
   !                                    and the answer
   !   CLOCK <hh:mm|--:-->              the war's own clock
   !   DEFCON <1-5>                     the war's own DEFCON, not the
   !                                    session's
   !   AC <id> <side> <fx> <fy> <tx> <ty> <progress>
   !   SHIP <id> <side> <fx> <fy> <tx> <ty> <progress>
   !   MSL <fx> <fy> <tx> <ty> <progress>      numbered here, in order
   !   TARGET <name> <status>
   !   EVENT <text>                     the last three are shown
   !
   ! Printed as a fixed-width teleprinter table: aircraft, then ships,
   ! then missiles; a quiet board says so; the targets on one line; and
   ! the tail of the event list.
   subroutine resume_radar()
      character(len=LL) :: key, targets, ev(LASTEV)
      integer :: i, nrows, nmsl, ntg, nev, k

      if (host_failed()) return
      if (rp_n >= 1 .and. trim(rp_line(1)) == 'NONE') then
         call emit(NO_ACTIVE_TRACKS)
         return
      end if

      call emit('TACTICAL TRACKS  ZULU '//trim(card_field('CLOCK'))// &
                '  DEFCON '//trim(card_field('DEFCON')))
      call emit(TRACKS_COLUMNS)

      nrows = 0
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) == 'AC') then
            call emit_track(word(rp_line(i), 2), 'AC', word(rp_line(i), 3), &
                            word(rp_line(i), 4), word(rp_line(i), 5), &
                            word(rp_line(i), 6), word(rp_line(i), 7), &
                            word(rp_line(i), 8))
            nrows = nrows + 1
         end if
      end do
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) == 'SHIP') then
            call emit_track(word(rp_line(i), 2), 'SHIP', word(rp_line(i), 3), &
                            word(rp_line(i), 4), word(rp_line(i), 5), &
                            word(rp_line(i), 6), word(rp_line(i), 7), &
                            word(rp_line(i), 8))
            nrows = nrows + 1
         end if
      end do
      nmsl = 0
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) == 'MSL') then
            nmsl = nmsl + 1
            call emit_track('MSL-'//two_digits(nmsl), 'MSL', ' ', &
                            word(rp_line(i), 2), word(rp_line(i), 3), &
                            word(rp_line(i), 4), word(rp_line(i), 5), &
                            word(rp_line(i), 6))
            nrows = nrows + 1
         end if
      end do
      if (nrows == 0) call emit(NO_TRACKS_AIRBORNE)

      ntg = 0
      targets = 'TARGETS: '
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) == 'TARGET') then
            if (ntg >= MAXTG) exit
            key = trim(word(rp_line(i), 2))//' '//trim(upcase(word(rp_line(i), 3)))
            if (ntg == 0) then
               targets = trim(targets)//' '//trim(key)
            else
               targets = trim(targets)//'  '//trim(key)
            end if
            ntg = ntg + 1
         end if
      end do
      if (ntg > 0) call emit(trim(targets))

      ! A ring of the last LASTEV event lines, in order.
      nev = 0
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) == 'EVENT') then
            if (nev < LASTEV) then
               nev = nev + 1
            else
               do k = 1, LASTEV - 1
                  ev(k) = ev(k + 1)
               end do
            end if
            ev(nev) = rest(rp_line(i), 2)
         end if
      end do
      do i = 1, nev
         call emit(trim(ev(i)))
      end do
   end subroutine resume_radar

   ! One row of the table. Columns are padded to a width, never cut:
   ! ID 10, TYP 5, SIDE 5, FROM 10, TO 10, then the progress.
   subroutine emit_track(tid, typ, side, fx, fy, tx, ty, prog)
      character(len=*), intent(in) :: tid, typ, side, fx, fy, tx, ty, prog
      character(len=LL) :: row
      integer :: col
      row = ' '
      col = 1
      call put(row, col, tid, 10)
      call put(row, col, typ, 5)
      call put(row, col, side, 5)
      call put(row, col, trim(fx)//' '//trim(fy), 10)
      call put(row, col, trim(tx)//' '//trim(ty), 10)
      call put(row, col, hundredths(prog), 0)
      call emit(trim(row))
   end subroutine emit_track

   ! The event log, as the host sends it: EVENT <kind> <actor> <summary>,
   ! oldest first. Printed as three columns -- kind and actor padded to
   ! eight, the summary cut at forty-four -- all in capitals.
   subroutine resume_journal()
      character(len=LL) :: summary, row
      integer :: i, n, col

      if (host_failed()) return
      n = 0
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) /= 'EVENT') cycle
         n = n + 1
         summary = upcase(rest(rp_line(i), 4))
         row = ' '
         col = 1
         call put(row, col, upcase(word(rp_line(i), 2)), 8)
         call put(row, col, upcase(word(rp_line(i), 3)), 8)
         call put(row, col, summary(1:44), 0)
         call emit(trim(row))
      end do
      if (n == 0) call emit(NO_EVENTS_LOGGED)
   end subroutine resume_journal

   subroutine resume_defcon()
      if (host_failed()) return
      call emit('DEFCON '//trim(st_pa1)//' SET')
   end subroutine resume_defcon

   ! A call that did not come back OK, said the way a player hears it
   ! from the executive. A subsystem being down was an ordinary Tuesday
   ! in 1983, and the honest behaviour is a message, not a hang.
   logical function host_failed() result(bad)
      character(len=LL) :: kind, reason

      bad = .true.
      if (trim(rp_status) == 'OK') then
         bad = .false.
         return
      end if
      if (trim(rp_status) == 'TIMEOUT') then
         call emit(CORE_TIMEOUT_TEXT)
         return
      end if
      kind = ' '
      reason = ' '
      if (rp_n >= 1) kind = rp_line(1)
      if (rp_n >= 2) reason = rp_line(2)
      select case (trim(kind))
      case ('BUSY')
         call emit(CORE_BUSY_TEXT)
      case ('REFUSED')
         call emit(IMPROPER_1)
         call emit(IMPROPER_2)
         if (len_trim(reason) > 0) then
            call emit(' ')
            call emit(trim(reason))
         end if
      case ('INTERP')
         call emit('UNKNOWN INTERPRETATION: '//trim(upcase(reason)))
      case default
         if (len_trim(reason) > 0) then
            call emit('ERROR: '//trim(reason))
         else
            call emit('ERROR: '//trim(kind))
         end if
      end select
   end function host_failed

   ! The value of a single-line card in the REPLY payload, or blank.
   function card_field(key) result(val)
      character(len=*), intent(in) :: key
      character(len=LL) :: val
      integer :: i
      val = ' '
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) == key) then
            val = rest(rp_line(i), 2)
            return
         end if
      end do
   end function card_field

   ! ================================================================
   ! Writing the response
   ! ================================================================
   subroutine emit(text)
      character(len=*), intent(in) :: text
      if (n_out >= MAXOU) return
      n_out = n_out + 1
      out_line(n_out) = text
   end subroutine emit

   subroutine write_response()
      integer :: i

      write(*, '(A)') 'SYSTEM/1 norad OK'
      write(*, '(A)') 'STATE 2'
      write(*, '(A)') 'PHASE '//trim(st_phase)
      write(*, '(A)') 'PA1 '//trim(st_pa1)
      write(*, '(A,I0)') 'DISPLAY ', n_out
      do i = 1, n_out
         write(*, '(A)') trim(out_line(i))
      end do
      if (trim(call_peer) /= '-') then
         write(*, '(A,I0)') 'CALL '//trim(call_peer)//' ', n_callp
         do i = 1, n_callp
            write(*, '(A)') trim(call_pay(i))
         end do
      end if
      write(*, '(A)') 'LINE UP'
      write(*, '(A)') 'END'
   end subroutine write_response

   subroutine protocol_error(why)
      character(len=*), intent(in) :: why
      write(*, '(A)') 'SYSTEM/1 norad OK'
      write(*, '(A)') 'STATE 0'
      write(*, '(A)') 'DISPLAY 1'
      write(*, '(A)') 'PROTOCOL ERROR: '//trim(why)
      write(*, '(A)') 'LINE DROP'
      write(*, '(A)') 'END'
      stop 1
   end subroutine protocol_error

   ! ================================================================
   ! Card-image helpers
   ! ================================================================

   ! The n-th blank-delimited word of a line, blank when absent.
   function word(line, n) result(out)
      character(len=*), intent(in) :: line
      integer, intent(in) :: n
      character(len=LL) :: out, buf
      integer :: k, i

      buf = adjustl(line)
      out = ' '
      do i = 1, n
         if (len_trim(buf) == 0) then
            out = ' '
            return
         end if
         k = index(trim(buf), ' ')
         if (k == 0) then
            if (i == n) then
               out = buf
            else
               out = ' '
            end if
            return
         end if
         out = buf(1:k-1)
         buf = adjustl(buf(k+1:))
      end do
   end function word

   ! Everything from the n-th word to the end of the line.
   function rest(line, n) result(out)
      character(len=*), intent(in) :: line
      integer, intent(in) :: n
      character(len=LL) :: out, buf
      integer :: k, i

      buf = adjustl(line)
      do i = 1, n - 1
         k = index(trim(buf), ' ')
         if (k == 0) then
            out = ' '
            return
         end if
         buf = adjustl(buf(k+1:))
      end do
      out = buf
   end function rest

   ! Write a field into a row at a column and advance the column by the
   ! field's width -- or by the field's own length when it is longer,
   ! because a column never cuts what it holds. A width of 0 is "as
   ! long as it is".
   subroutine put(row, col, s, w)
      character(len=*), intent(inout) :: row
      integer, intent(inout) :: col
      character(len=*), intent(in) :: s
      integer, intent(in) :: w
      integer :: n
      n = len_trim(s)
      if (n > 0) row(col:col+n-1) = s(1:n)
      col = col + max(n, w)
   end subroutine put

   ! A number as the host wrote it, shown to two decimal places.
   function hundredths(s) result(out)
      character(len=*), intent(in) :: s
      character(len=16) :: out, buf
      double precision :: v
      integer :: ios
      read(s, *, iostat=ios) v
      if (ios /= 0) v = 0.0d0
      write(buf, '(F12.2)') v
      out = adjustl(buf)
   end function hundredths

   function two_digits(n) result(out)
      integer, intent(in) :: n
      character(len=2) :: out
      write(out, '(I2.2)') n
   end function two_digits

   function upcase(s) result(out)
      character(len=*), intent(in) :: s
      character(len=LL) :: out
      integer :: i, c
      out = s
      do i = 1, len_trim(out)
         c = iachar(out(i:i))
         if (c >= 97 .and. c <= 122) out(i:i) = achar(c - 32)
      end do
   end function upcase

   function to_int(s) result(v)
      character(len=*), intent(in) :: s
      integer :: v, ios
      if (len_trim(s) == 0) then
         v = 0
         return
      end if
      read(s, *, iostat=ios) v
      if (ios /= 0) v = 0
   end function to_int

   function itoa(v) result(out)
      integer, intent(in) :: v
      character(len=12) :: buf
      character(len=12) :: out
      write(buf, '(I0)') v
      out = adjustl(buf)
   end function itoa

end program norad
