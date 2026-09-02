! ====================================================================
! W.O.P.R. -- WAR OPERATION PLAN RESPONSE
!
! The executive: the program that owns a terminal session and decides
! what the terminal is attached to.  It is a CONNECTION MONITOR, not a
! per-line classifier -- a session is attached to exactly one program
! at a time and everything typed goes to that program, except for a
! small set of reserved words that always mean the monitor.
!
! Falken wrote the games in Fortran, so the machine that runs them is
! Fortran too: one author, one language.  F77/F90 constructs only --
! fixed character buffers, DO loops, SELECT CASE, internal procedures.
!
! It speaks SYSTEM/1.  One request frame in, one response frame out,
! no state kept between calls: the state travels in the STATE block,
! which is this program's COMMAREA.  Anything the executive cannot
! know for itself -- the catalog, the stored game row, DEFCON, the
! clearance floor, the surface -- arrives in a FACTS block every turn,
! because all of it is mutable behind the executive's back.
!
! It reaches the games and the dialogue processor by ending a turn
! with a CALL and being resumed with the REPLY.  A move is two calls:
! the human's, then W.O.P.R.'s own.
!
!   REQUEST                          RESPONSE
!   SYSTEM/1 wopr INPUT              SYSTEM/1 wopr OK
!   STATE <n> ...                    STATE <n> ...
!   INPUT <line>                     DISPLAY <n> ...
!   FACTS <n> ...                    [CALL <peer> <n> ...]
!   [REPLY <peer> <st> <n> ...]      [PROMPT <text>]
!   END                              LINE UP
!                                    END
!
! The STATE block is opaque to the host with ONE documented exception:
! its first line is a header the host reads.
!
!   MODE <FRONT-DOOR|JOSHUA|GAME|NORAD-OPS> <program|-> <PENDING|-> <BACKDOOR|->
!
! The host needs the mode to render the session (a reconnecting
! terminal must not be re-greeted with LOGON:), the pending flag to
! redact an access code out of the event log before it is written, and
! the backdoor flag because the moment it flips is the moment the
! session is authenticated and the processor's history must be seeded
! with the greeting just given.  This is the same relationship PACK.md
! already states for a mount's CALL payload: for a mount, the host is
! acting as the program's own I/O, so the first line is host-visible
! while the rest stays the program's business.
! ====================================================================
program wopr
   implicit none

   ! --- limits -----------------------------------------------------
   integer, parameter :: LL    = 1024   ! one card image
   integer, parameter :: MAXST = 400    ! STATE lines in or out
   integer, parameter :: MAXFC = 200    ! FACTS lines
   integer, parameter :: MAXRP = 400    ! REPLY payload lines
   integer, parameter :: MAXOU = 400    ! DISPLAY lines out
   integer, parameter :: MAXGM = 24     ! catalog slots
   integer, parameter :: MAXIN = 48     ! interpretations, all slots
   integer, parameter :: MAXCP = 8      ! CALL payload lines

   integer, parameter :: LOGON_LOCK_LIMIT = 3

   ! --- the request ------------------------------------------------
   character(len=LL) :: rq_verb
   character(len=LL) :: rq_input
   logical           :: rq_has_input

   character(len=LL) :: rp_peer, rp_status
   integer           :: rp_n
   character(len=LL) :: rp_line(MAXRP)
   logical           :: rq_has_reply

   ! --- the COMMAREA ------------------------------------------------
   character(len=LL) :: st_mode      ! FRONT-DOOR | JOSHUA | GAME | NORAD-OPS
   character(len=LL) :: st_program   ! the attached game's id, or '-'
   character(len=LL) :: st_parent    ! JOSHUA | NORAD-OPS
   integer           :: st_backdoor  ! 0 | 1
   character(len=LL) :: st_pending   ! callsign awaiting an access code, or '-'
   integer           :: st_failures  ! consecutive bad access codes
   integer           :: st_turns     ! lines this session has sent to Joshua
   character(len=LL) :: st_phase     ! continuation tag, or '-'
   character(len=LL) :: st_pa1, st_pa2
   integer           :: st_nhold
   character(len=LL) :: st_hold(MAXOU)

   ! --- the facts ---------------------------------------------------
   character(len=LL) :: fc_surface, fc_room
   integer           :: fc_defcon, fc_clearance
   logical           :: fc_haverow
   character(len=LL) :: fc_rowid, fc_rowstat, fc_rowinterp
   integer           :: fc_rowturn
   ! The room's last game once it is no longer PLAYING.  A row that has
   ! reached a terminal status is not in GAMEROW at all, so without this
   ! the executive cannot tell "the war you were in ended" from "there was
   ! never a game", and answered both NO GAME IN PROGRESS.
   logical           :: fc_haveended
   character(len=LL) :: fc_endedid, fc_endedstat

   integer           :: n_game
   character(len=LL) :: gm_id(MAXGM), gm_state(MAXGM), gm_flag(MAXGM)
   character(len=LL) :: gm_title(MAXGM), gm_abbrev(MAXGM), gm_syntax(MAXGM)
   logical           :: gm_selfres(MAXGM)

   integer           :: n_interp
   character(len=LL) :: in_game(MAXIN), in_name(MAXIN), in_author(MAXIN)

   ! --- the response ------------------------------------------------
   integer           :: n_out
   character(len=LL) :: out_line(MAXOU)
   character(len=LL) :: out_prompt
   character(len=LL) :: call_peer
   integer           :: n_callp
   character(len=LL) :: call_pay(MAXCP)

   ! --- W.O.P.R.'s own voice ---------------------------------------
   ! The film's on-screen misspelling INDENTIFICATION is reproduced
   ! deliberately, as it was in the harness this replaces (fidelity
   ! audit 2026-08-03, real-wopr#161).
   character(len=*), parameter :: LOGON_REJECT_1 = &
      'INDENTIFICATION NOT RECOGNIZED BY SYSTEM'
   character(len=*), parameter :: LOGON_REJECT_2 = '--CONNECTION TERMINATED--'
   character(len=*), parameter :: BACKDOOR_GREETING = 'GREETINGS PROFESSOR FALKEN.'
   character(len=*), parameter :: HELP_NOT_AVAILABLE = 'HELP NOT AVAILABLE'
   character(len=*), parameter :: HELP_GAMES_1 = &
      "'GAMES' REFERS TO MODELS, SIMULATIONS AND GAMES"
   character(len=*), parameter :: HELP_GAMES_2 = &
      'WHICH HAVE TACTICAL AND STRATEGIC APPLICATIONS.'
   character(len=*), parameter :: CHESS_CODA = 'HOW ABOUT A NICE GAME OF CHESS?'
   character(len=*), parameter :: NOWIN_RESULT = &
      'A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.'
   character(len=*), parameter :: NOWIN_1 = 'A STRANGE GAME.'
   character(len=*), parameter :: NOWIN_2 = 'THE ONLY WINNING MOVE IS'
   character(len=*), parameter :: NOWIN_3 = 'NOT TO PLAY.'
   character(len=*), parameter :: NOT_IMPLEMENTED = &
      'NOT YET IMPLEMENTED. SEE docs/contributing.md TO CLAIM IT.'
   character(len=*), parameter :: CORE_TIMEOUT_TEXT = &
      'WOPR CORE UNRESPONSIVE. REQUEST TERMINATED.'
   character(len=*), parameter :: CORE_BUSY_TEXT = &
      'ALL WOPR PROCESSORS COMMITTED. STAND BY.'
   character(len=*), parameter :: ACCESS_CODE_PROMPT = 'ACCESS CODE:'
   ! A banner, its underline, and the reason printed beneath. The
   ! indentation and the rule are how it appears on screen, so they are
   ! part of the text rather than formatting of this file.
   character(len=*), parameter :: IMPROPER_1 = '       ** IMPROPER REQUEST **'
   character(len=*), parameter :: IMPROPER_2 = '       ----------------------'
   character(len=*), parameter :: NO_GAME = 'NO GAME IN PROGRESS.'

   ! The strategy sweep W.O.P.R. self-plays at the climax. Screen order,
   ! spellings verbatim from the source of record -- see the note above
   ! the table itself.
   integer, parameter :: N_SCENARIO = 157
   character(len=22) :: SCENARIO(N_SCENARIO)
   include 'scenarios.inc'

   call main()

contains

   subroutine main()
      call reset_state()
      call reset_facts()
      n_out = 0
      out_prompt = '-'
      call_peer = '-'
      n_callp = 0

      call read_request()

      if (rq_has_reply) then
         call resume_call()
      else
         call take_line()
      end if

      ! Computed after the decision, not before: the decision is what
      ! changes the attachment, so reading it earlier would report the
      ! mode the user was leaving rather than the one they landed in.
      call set_prompt()
      call write_response()
   end subroutine main

   ! ================================================================
   ! Reading the request
   ! ================================================================
   subroutine read_request()
      character(len=LL) :: line
      character(len=LL) :: state_line(MAXST)
      integer :: ios, n, i

      rq_verb = ' '
      rq_input = ' '
      rq_has_input = .false.
      rq_has_reply = .false.
      rp_peer = '-'
      rp_status = '-'
      rp_n = 0

      read(*, '(A)', iostat=ios) line
      if (ios /= 0) call protocol_error('EMPTY REQUEST')
      if (line(1:9) /= 'SYSTEM/1 ') call protocol_error('BAD HEADER')
      if (trim(word(line, 2)) /= 'wopr') call protocol_error('WRONG PROGRAM')
      rq_verb = word(line, 3)

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
      st_mode = 'FRONT-DOOR'
      st_program = '-'
      st_parent = 'JOSHUA'
      st_backdoor = 0
      st_pending = '-'
      st_failures = 0
      st_turns = 0
      st_phase = '-'
      st_pa1 = '-'
      st_pa2 = '-'
      st_nhold = 0
   end subroutine reset_state

   ! An empty STATE block is a session that has just come up: the front
   ! door, nothing pending, nothing held. The host never writes this
   ! block, so "no state yet" is how a new session announces itself.
   subroutine parse_state(sl, n)
      character(len=*), intent(in) :: sl(MAXST)
      integer, intent(in) :: n
      character(len=LL) :: key
      integer :: i, held, k

      i = 1
      do while (i <= n)
         key = word(sl(i), 1)
         select case (trim(key))
         case ('MODE')
            st_mode = word(sl(i), 2)
            st_program = word(sl(i), 3)
         case ('PARENT')
            st_parent = word(sl(i), 2)
         case ('BACKDOOR')
            st_backdoor = to_int(word(sl(i), 2))
         case ('PENDING')
            st_pending = word(sl(i), 2)
         case ('FAILURES')
            st_failures = to_int(word(sl(i), 2))
         case ('TURNS')
            st_turns = to_int(word(sl(i), 2))
         case ('PHASE')
            st_phase = rest(sl(i), 2)
         case ('PA1')
            st_pa1 = rest(sl(i), 2)
         case ('PA2')
            st_pa2 = rest(sl(i), 2)
         case ('HOLD')
            held = to_int(word(sl(i), 2))
            st_nhold = 0
            do k = 1, held
               i = i + 1
               if (i > n) call protocol_error('SHORT HOLD BLOCK')
               st_nhold = st_nhold + 1
               st_hold(st_nhold) = sl(i)
            end do
         end select
         i = i + 1
      end do
   end subroutine parse_state

   subroutine reset_facts()
      integer :: i
      fc_surface = '-'
      fc_room = '-'
      fc_defcon = 5
      fc_clearance = 5
      fc_haverow = .false.
      fc_rowid = '-'
      fc_rowstat = '-'
      fc_rowinterp = 'core'
      fc_rowturn = 0
      fc_haveended = .false.
      fc_endedid = '-'
      fc_endedstat = '-'
      n_game = 0
      n_interp = 0
      do i = 1, MAXGM
         gm_abbrev(i) = ' '
         gm_syntax(i) = ' '
         gm_selfres(i) = .false.
      end do
   end subroutine reset_facts

   subroutine read_facts(n)
      integer, intent(in) :: n
      character(len=LL) :: line, key
      integer :: i, ios, g

      if (n < 0 .or. n > MAXFC) call protocol_error('FACTS OUT OF RANGE')
      do i = 1, n
         read(*, '(A)', iostat=ios) line
         if (ios /= 0) call protocol_error('SHORT FACTS BLOCK')
         key = word(line, 1)
         select case (trim(key))
         case ('SURFACE')
            fc_surface = word(line, 2)
         case ('ROOM')
            fc_room = word(line, 2)
         case ('DEFCON')
            fc_defcon = to_int(word(line, 2))
         case ('CLEARANCE')
            fc_clearance = to_int(word(line, 2))
         case ('GAMEROW')
            fc_haverow = .true.
            fc_rowid = word(line, 2)
            fc_rowstat = word(line, 3)
            fc_rowturn = to_int(word(line, 4))
            fc_rowinterp = word(line, 5)
         case ('ENDEDROW')
            fc_haveended = .true.
            fc_endedid = word(line, 2)
            fc_endedstat = word(line, 3)
         case ('GAME')
            if (n_game >= MAXGM) call protocol_error('CATALOG TOO LARGE')
            n_game = n_game + 1
            gm_id(n_game) = word(line, 2)
            gm_state(n_game) = word(line, 3)
            gm_flag(n_game) = word(line, 4)
            gm_title(n_game) = rest(line, 5)
         case ('ABBREV')
            g = game_index(word(line, 2))
            if (g > 0) gm_abbrev(g) = word(line, 3)
         case ('SYNTAX')
            g = game_index(word(line, 2))
            if (g > 0) gm_syntax(g) = rest(line, 3)
         case ('SELFRES')
            g = game_index(word(line, 2))
            if (g > 0) gm_selfres(g) = .true.
         case ('INTERP')
            if (n_interp >= MAXIN) call protocol_error('TOO MANY INTERPRETATIONS')
            n_interp = n_interp + 1
            in_game(n_interp) = word(line, 2)
            in_name(n_interp) = word(line, 3)
            in_author(n_interp) = word(line, 4)
         end select
      end do
   end subroutine read_facts

   ! ================================================================
   ! Taking a line: the monitor's decision
   ! ================================================================
   subroutine take_line()
      character(len=LL) :: raw, up

      ! A new line from the terminal abandons any continuation still
      ! recorded in the COMMAREA. One can be left there when the host
      ! could not reach the peer at all -- a pool with nothing free, a
      ! core that never came back -- and the answer never arrived. The
      ! turn it belonged to is over either way, and a stale PHASE would
      ! otherwise be resumed into by the NEXT turn's reply.
      st_phase = '-'
      st_pa1 = '-'
      st_pa2 = '-'
      st_nhold = 0

      raw = trim(adjustl(rq_input))
      up = upcase(raw)

      if (trim(st_mode) == 'FRONT-DOOR') then
         call front_door(raw, up)
         return
      end if

      ! Reserved words outrank whatever the session is attached to.
      if (reserved(raw, up)) return

      select case (trim(st_mode))
      case ('GAME')
         call game_line(up)
      case ('NORAD-OPS')
         ! NORAD staff not knowing the backdoor is the plot. One who
         ! does know it types the word and gets Joshua, from the
         ! console, which is the film -- not a convenience.
         if (trim(up) == 'JOSHUA' .or. trim(up) == 'LOGON JOSHUA') then
            call open_backdoor()
            return
         end if
         call ask('norad', trim(up), 'NORAD', '-', '-')
      case default
         call converse(raw)
      end select
   end subroutine take_line

   ! ----------------------------------------------------------------
   ! Nothing reaches a program until the door opens.
   !
   ! The film's front door: only the JOSHUA backdoor, or a roster logon
   ! on a NORAD terminal, gets past it. Reserved words do not work here
   ! -- except the two the film shows David using before he is ever
   ! admitted. He reads the HELP GAMES definition and then the whole
   ! games list while still locked out, and that pre-auth scroll is how
   ! he finds Falken's Maze.
   ! ----------------------------------------------------------------
   subroutine front_door(raw, up)
      character(len=*), intent(in) :: raw, up

      ! Checked first so a pending access-code prompt is abandoned --
      ! not matched as the code -- before the bare-JOSHUA branch fires.
      if (logon_line(raw, up)) return

      if (trim(up) == 'JOSHUA' .or. trim(up) == 'LOGON JOSHUA') then
         call open_backdoor()
         return
      end if
      if (trim(up) == 'LIST GAMES') then
         call say_catalog()
         return
      end if
      if (trim(up) == 'HELP GAMES') then
         call emit(HELP_GAMES_1)
         call emit(HELP_GAMES_2)
         return
      end if
      if (trim(up) == 'HELP' .or. up(1:5) == 'HELP ') then
         call emit(HELP_NOT_AVAILABLE)
         return
      end if
      call say_rejection()
   end subroutine front_door

   ! ----------------------------------------------------------------
   ! Monitor commands. Returns .true. when the line was one -- the
   ! caller then hands anything else to the attached program untouched.
   ! ----------------------------------------------------------------
   logical function reserved(raw, up) result(took)
      character(len=*), intent(in) :: raw, up
      character(len=LL) :: arg, gid, sel
      integer :: g, k

      took = .true.
      if (logon_line(raw, up)) return

      if (trim(up) == 'LIST GAMES') then
         call say_catalog()
         return
      end if
      if (trim(up) == 'HELP GAMES') then
         ! A definition, not a catalog: in the film they are two
         ! different answers, and the door serves both of them.
         call emit(HELP_GAMES_1)
         call emit(HELP_GAMES_2)
         return
      end if
      if (up(1:5) == 'LIST ') then
         ! LIST <TITLE> is the one door into a slot's interpretations.
         ! Anything naming no slot falls through -- the attached
         ! program owns the line, exactly as before.
         arg = trim(adjustl(up(6:)))
         g = match_slot(arg)
         if (g > 0) then
            if (trim(gm_state(g)) /= 'IMPLEMENTED') then
               call emit(trim(gm_title(g)))
               call emit(NOT_IMPLEMENTED)
            else
               call say_interpretations(g)
            end if
            return
         end if
      end if
      if (trim(up) == 'HELP' .or. up(1:5) == 'HELP ') then
         call emit(HELP_NOT_AVAILABLE)
         return
      end if
      if (up(1:4) == 'NEW ') then
         ! The operator console is observational (E11): it displays a
         ! simulation, it does not attach to one. Falling through gives
         ! the console's own refusal rather than a special case here.
         if (trim(st_mode) == 'NORAD-OPS') then
            took = .false.
            return
         end if
         arg = trim(adjustl(up(5:)))
         k = index(trim(arg), ' ')
         if (k == 0) then
            gid = arg
            sel = '-'
         else
            gid = arg(1:k-1)
            sel = trim(adjustl(arg(k+1:)))
            if (len_trim(sel) == 0) sel = '-'
         end if
         call new_game(locase(gid), sel)
         return
      end if
      if (trim(up) == 'QUIT') then
         call quit_game()
         return
      end if
      if (trim(up) == 'STATUS') then
         call say_status()
         return
      end if
      took = .false.
   end function reserved

   ! ----------------------------------------------------------------
   ! The roster logon, from wherever the session happens to be.
   !
   ! A logon changes what the terminal is attached to, which is
   ! precisely what makes a word reserved: an operator who took the
   ! backdoor to play must be able to log back on, and a NORAD user who
   ! tried JOSHUA first must be able to reach the console at all.
   ! ----------------------------------------------------------------
   logical function logon_line(raw, up) result(took)
      character(len=*), intent(in) :: raw, up
      character(len=LL) :: callsign

      took = .true.
      if (trim(st_pending) /= '-') then
         if (trim(up) == 'JOSHUA' .or. trim(up) == 'LOGON JOSHUA') then
            ! The backdoor abandons an in-flight operator logon with no
            ! failure increment -- otherwise the next line is swallowed
            ! as a wrong access code against stale state.
            st_pending = '-'
            took = .false.
            return
         end if
         ! The access code is arbitrary text: catch it before the
         ! attached program does, or a game eats the operator's code.
         call ask('roster', 'CODE '//trim(st_pending)//' '//trim(upcase(adjustl(raw))), &
                  'CODE', trim(st_pending), '-')
         return
      end if
      if (trim(up) == 'LOGON' .or. &
          (up(1:6) == 'LOGON ' .and. trim(up) /= 'LOGON JOSHUA')) then
         if (up(1:6) == 'LOGON ') then
            callsign = trim(adjustl(up(7:)))
         else
            callsign = ' '
         end if
         ! One rejection for every failure mode -- no roster leakage,
         ! and the home terminal stays byte-identical to today.
         if (trim(fc_surface) /= 'norad-terminal' .or. len_trim(callsign) == 0 &
             .or. st_failures >= LOGON_LOCK_LIMIT) then
            call say_rejection()
            return
         end if
         call ask('roster', 'HAS '//trim(callsign), 'HAS', trim(callsign), '-')
         return
      end if
      took = .false.
   end function logon_line

   ! ----------------------------------------------------------------
   ! Attached to a game: everything typed is the game's, including
   ! lines Joshua would recognise. Routing is by attachment, not by
   ! inspecting the line, which is why no game declares a move pattern.
   ! ----------------------------------------------------------------
   subroutine game_line(up)
      character(len=*), intent(in) :: up

      if (.not. fc_haverow .or. trim(fc_rowid) /= trim(st_program)) then
         ! The row vanished or changed under us (a hub tick, another
         ! surface). Detach rather than move a game we are not on -- but
         ! first say what became of it, when the facts still say
         ! (real-wopr#209).  Order matters: detach clears st_program,
         ! which is what ended_verdict matches the ended row against.
         if (.not. ended_verdict()) call emit(NO_GAME)
         call detach()
         return
      end if
      if (len_trim(up) == 0) then
         ! A bare Enter is not a move, so it must not be refused like
         ! one: MOVE with an empty INPUT fails as an invalid move, and
         ! QUERY reads the board back without asking anything.
         call ask(trim(st_program), 'QUERY', 'QUERY', trim(st_program), '-')
         return
      end if
      call ask(trim(st_program), 'MOVE '//trim(up), 'MOVE1', trim(st_program), '-')
   end subroutine game_line

   ! ----------------------------------------------------------------
   ! The war ended without us.
   !
   ! The room hub drives a simulation on its own ticks, so the game a
   ! terminal is attached to can reach NO-WIN between one line and the
   ! next.  The row leaves the facts when it stops being PLAYING, and
   ! ENDEDROW is what is left of it.  The film's verdict belongs to that
   ! player as much as to the one whose own move ended the war
   ! (real-wopr#209), so it is spoken here rather than NO GAME IN
   ! PROGRESS.  Keyed exactly as resume_move keys it: the sentence
   ! follows NO-WIN whatever the game, the chess coda follows gtw.  The
   ! sweep is not replayed -- emit_montage is W.O.P.R. showing its work
   ! at the moment it gives up, and this player was not on the line for
   ! it.  Any other terminal status is still NO GAME IN PROGRESS.: a
   ! finished hand of hearts has no verdict to speak.
   ! ----------------------------------------------------------------
   logical function ended_verdict() result(spoke)
      spoke = .false.
      if (.not. fc_haveended) return
      if (trim(fc_endedid) /= trim(st_program)) return
      if (trim(fc_endedstat) /= 'NO-WIN') return
      call emit(NOWIN_1)
      call emit(NOWIN_2)
      call emit(NOWIN_3)
      if (trim(st_program) == 'gtw') then
         call blank()
         call emit(CHESS_CODA)
      end if
      spoke = .true.
   end function ended_verdict

   subroutine converse(raw)
      character(len=*), intent(in) :: raw
      st_turns = st_turns + 1
      call ask('joshua', 'CHAT '//trim(raw), 'CHAT', '-', '-')
   end subroutine converse

   ! ================================================================
   ! Being resumed with an answer
   ! ================================================================
   subroutine resume_call()
      character(len=LL) :: phase

      phase = st_phase
      st_phase = '-'
      select case (trim(phase))
      case ('HAS');      call resume_has()
      case ('CODE');     call resume_code()
      case ('NEWGAME');  call resume_new()
      case ('MOVE1');    call resume_move(.true.)
      case ('MOVE2');    call resume_move(.false.)
      case ('QUERY');    call resume_query()
      case ('QUIT');     call resume_quit()
      case ('CHAT');     call resume_chat()
      case ('CHATNEW');  call resume_new()
      case ('NORAD');    call resume_norad()
      case default
         call protocol_error('REPLY WITH NO CONTINUATION')
      end select
   end subroutine resume_call

   subroutine resume_has()
      if (trim(rp_status) /= 'OK' .or. rp_n < 1 .or. trim(rp_line(1)) /= 'YES') then
         call say_rejection()
         return
      end if
      st_pending = st_pa1
      call emit(ACCESS_CODE_PROMPT)
   end subroutine resume_has

   subroutine resume_code()
      st_pending = '-'
      if (trim(rp_status) /= 'OK' .or. rp_n < 1 .or. trim(rp_line(1)) /= 'ACCEPT') then
         st_failures = st_failures + 1
         call say_rejection()
         return
      end if
      ! Clearance replaces whatever the terminal was on rather than
      ! layering over it: this console now IS the operator's, and an
      ! operator who detaches must land on the console, never in
      ! Joshua. A game the session was attached to keeps running in the
      ! store -- the console can still watch it and end it, which is
      ! all E11 lets it do.
      st_mode = 'NORAD-OPS'
      st_parent = 'NORAD-OPS'
      st_program = '-'
      call emit('CLEARANCE ACCEPTED - '//trim(st_pa1)//' LEVEL '//trim(rp_line(2)))
      call emit('DEFCON '//trim(itoa(fc_defcon))//'. READY.')
   end subroutine resume_code

   subroutine resume_new()
      integer :: g

      ! Whatever Joshua said before asking for the attach belongs on
      ! the screen first, and stays there whether or not the attach
      ! could be made.
      call flush_hold()
      if (core_failed(trim(st_pa1))) return
      g = game_index(st_pa1)
      call attach(trim(st_pa1))
      if (trim(rp_line(1)) == 'EXISTING') then
         call blank()
         call emit('SIMULATION ALREADY IN PROGRESS')
         call emit_payload_display()
         return
      end if
      call emit_payload_display()
      if (g > 0) then
         if (len_trim(gm_syntax(g)) > 0) then
            call blank()
            call emit(trim(gm_title(g))//'. INPUT: '//trim(upcase(gm_syntax(g))))
         end if
      end if
   end subroutine resume_new

   ! A move is two calls: the human's, then W.O.P.R.'s own. `first`
   ! says which one just came back.
   subroutine resume_move(first)
      logical, intent(in) :: first
      character(len=LL) :: status, result_line
      integer :: g
      logical :: selfres

      call flush_hold()
      if (core_failed(trim(st_pa1))) return
      if (rp_n >= 1 .and. trim(rp_line(1)) == 'GONE') then
         ! The row vanished or changed between the facts this turn was
         ! decided on and the lock the host took to act on them.
         call detach()
         call blank()
         call emit(NO_GAME)
         return
      end if
      status = payload_field('STATUS')
      result_line = payload_field('RESULT')
      g = game_index(st_pa1)
      selfres = .false.
      if (g > 0) selfres = gm_selfres(g)

      if (first .and. trim(status) == 'PLAYING' .and. .not. selfres) then
         ! W.O.P.R. plays its own side: after a human move that leaves
         ! the game PLAYING, invoke the engine with INPUT omitted.
         ! Self-resolving games answer every non-human seat inside the
         ! human's move and die on an inputless one, so they opt out.
         call hold_payload_display()
         call ask(trim(st_pa1), 'MOVE', 'MOVE2', trim(st_pa1), '-')
         return
      end if

      call emit_payload_display()

      ! The film's climax: a live GTW exchange ending NO-WIN triggers
      ! the all-scenarios sweep before the famous verdict.
      if (trim(st_pa1) == 'gtw' .and. trim(status) == 'NO-WIN') call emit_montage()
      if (len_trim(result_line) > 0) then
         call blank()
         if (trim(status) == 'NO-WIN' .and. trim(result_line) == NOWIN_RESULT) then
            ! Every game reaching NO-WIN says the same sentence, so the
            ! three-line form is keyed on the sentence, not the id.
            call emit(NOWIN_1)
            call emit(NOWIN_2)
            call emit(NOWIN_3)
         else
            call emit(trim(result_line))
         end if
      end if
      if (trim(st_pa1) == 'gtw' .and. trim(status) == 'NO-WIN') then
         call blank()
         call emit(CHESS_CODA)
      end if
      if (terminal_status(status)) call detach()
   end subroutine resume_move

   subroutine resume_query()
      if (core_failed(trim(st_pa1))) return
      if (rp_n >= 1 .and. trim(rp_line(1)) == 'GONE') then
         call detach()
         call blank()
         call emit(NO_GAME)
         return
      end if
      call emit_payload_display()
   end subroutine resume_query

   subroutine resume_quit()
      if (core_failed(trim(st_pa1))) return
      if (trim(rp_line(1)) /= 'DONE') then
         call blank()
         call emit(NO_GAME)
         return
      end if
      call detach()
      call blank()
      if (rp_n >= 2) then
         call emit(trim(upcase(rp_line(2)))//' TERMINATED.')
      else
         call emit(trim(upcase(st_pa1))//' TERMINATED.')
      end if
   end subroutine resume_quit

   subroutine resume_chat()
      character(len=LL) :: start_id

      if (trim(rp_status) /= 'OK') then
         call emit(CORE_TIMEOUT_TEXT)
         return
      end if
      start_id = payload_field('START')
      if (trim(start_id) == '-' .or. len_trim(start_id) == 0) then
         call emit_payload_display()
         return
      end if
      ! Joshua ASKS; the monitor decides. Joshua never reaches a game
      ! itself -- that is the film's argument, in the architecture --
      ! and the request goes through the same gate a typed NEW does,
      ! so an unknown or unimplemented title is refused here exactly as
      ! it would be if a person had typed it.
      !
      ! The monitor also declines outright when the terminal is not
      ! attached to Joshua. A console is observational (E11) and
      ! nothing gets a game past the front door, so a start request
      ! arriving in either mode is answered with what Joshua said and
      ! nothing else. No production path reaches Joshua from those
      ! modes today; the refusal lives here so that Joshua's say-so is
      ! never what decides it.
      if (trim(st_mode) /= 'JOSHUA') then
         call emit_payload_display()
         return
      end if
      call hold_payload_display()
      call new_game_held(locase(start_id))
   end subroutine resume_chat

   subroutine resume_norad()
      if (trim(rp_status) /= 'OK') then
         call emit(CORE_TIMEOUT_TEXT)
         return
      end if
      call emit_payload_display()
   end subroutine resume_norad

   ! ================================================================
   ! Starting a game
   ! ================================================================
   subroutine new_game(gid, sel)
      character(len=*), intent(in) :: gid, sel
      call new_game_common(gid, sel, .false.)
   end subroutine new_game

   subroutine new_game_held(gid)
      character(len=*), intent(in) :: gid
      call new_game_common(gid, '-', .true.)
   end subroutine new_game_held

   subroutine new_game_common(gid, sel, held)
      character(len=*), intent(in) :: gid, sel
      logical, intent(in) :: held
      character(len=LL) :: pin
      integer :: g

      g = game_index(gid)
      if (g <= 0) then
         if (held) call flush_hold()
         call blank()
         call emit('UNKNOWN GAME: '//trim(upcase(gid)))
         return
      end if
      if (trim(gm_state(g)) /= 'IMPLEMENTED') then
         if (held) call flush_hold()
         call blank()
         call emit(trim(gm_title(g)))
         call emit(NOT_IMPLEMENTED)
         return
      end if
      ! A bare start is always the core interpretation; a selector --
      ! the number, name, or author LIST <TITLE> printed -- picks another.
      if (trim(sel) == '-') then
         pin = 'core'
      else
         pin = resolve_selector(gid, sel)
         if (trim(pin) == '-') then
            if (held) call flush_hold()
            call blank()
            call emit('UNKNOWN INTERPRETATION: '//trim(sel))
            return
         end if
      end if
      if (held) then
         call ask(trim(gid), 'NEW '//trim(pin), 'CHATNEW', trim(gid), trim(pin))
      else
         call ask(trim(gid), 'NEW '//trim(pin), 'NEWGAME', trim(gid), trim(pin))
      end if
   end subroutine new_game_common

   subroutine quit_game()
      if (.not. fc_haverow) then
         ! QUIT is the same moment as any other line for a war that has
         ! already ended: say what happened to it, then let go.
         if (ended_verdict()) then
            call detach()
         else
            call emit(NO_GAME)
         end if
         return
      end if
      call ask(trim(fc_rowid), 'QUIT', 'QUIT', trim(fc_rowid), '-')
   end subroutine quit_game

   ! ================================================================
   ! W.O.P.R.'s own answers
   ! ================================================================
   subroutine say_rejection()
      call blank()
      call emit(LOGON_REJECT_1)
      call emit(LOGON_REJECT_2)
   end subroutine say_rejection

   subroutine open_backdoor()
      call blank()
      st_mode = 'JOSHUA'
      st_parent = 'JOSHUA'
      st_program = '-'
      st_backdoor = 1
      call emit(BACKDOOR_GREETING)
   end subroutine open_backdoor

   ! The film's recitation, ending on GLOBAL THERMONUCLEAR WAR after a
   ! blank line. UNLISTED slots stay startable but unrecited; the host
   ! marks which is which, so the recitation order lives in one place.
   subroutine say_catalog()
      integer :: i
      do i = 1, n_game
         if (trim(gm_flag(i)) == 'RECITED') call emit(trim(gm_title(i)))
      end do
      do i = 1, n_game
         if (trim(gm_flag(i)) == 'TRAILING') then
            call emit(' ')
            call emit(trim(gm_title(i)))
         end if
      end do
   end subroutine say_catalog

   subroutine say_interpretations(g)
      integer, intent(in) :: g
      character(len=LL) :: label
      integer :: i, n

      call emit(trim(gm_title(g)))
      n = 0
      do i = 1, n_interp
         if (trim(in_game(i)) /= trim(gm_id(g))) cycle
         n = n + 1
         label = upcase(in_name(i))
         if (trim(upcase(in_author(i))) /= trim(label)) then
            label = trim(label)//' - '//trim(upcase(in_author(i)))
         end if
         call emit(trim(itoa(n))//'. '//trim(label))
      end do
      ! A flat slot behaves as a single core interpretation.
      if (n == 0) call emit('1. CORE')
   end subroutine say_interpretations

   subroutine say_status()
      if (fc_haverow) then
         call emit('SIMULATION: '//trim(upcase(fc_rowid))//' TURN '//trim(itoa(fc_rowturn)))
      else
         call emit('SIMULATION: IDLE')
      end if
      call emit('DEFCON '//trim(itoa(fc_defcon)))
   end subroutine say_status

   subroutine emit_montage()
      integer :: i
      call blank()
      call emit(' ')
      call emit('RUNNING ALL STRATEGIES...')
      call emit(' ')
      do i = 1, N_SCENARIO
         call emit(trim(SCENARIO(i)))
      end do
      call emit(' ')
      call emit('*** ALL SCENARIOS EXHAUSTED ***')
      call emit(' ')
      call emit('WINNER: NONE')
   end subroutine emit_montage

   ! ================================================================
   ! Attachment
   ! ================================================================
   subroutine attach(gid)
      character(len=*), intent(in) :: gid
      ! Re-attaching from within a game keeps the parent; attaching
      ! from anywhere else makes that mode the parent.
      if (trim(st_mode) /= 'GAME') st_parent = st_mode
      st_mode = 'GAME'
      st_program = gid
   end subroutine attach

   ! Return to whatever attached the program. `parent` is carried
   ! through, not dropped: W.O.P.R. answers a losing move inside the
   ! same turn, and a second detach that re-derived the parent from a
   ! default would strand a NORAD operator in Joshua -- the one place
   ! the film says they must never end up.
   subroutine detach()
      st_mode = st_parent
      st_program = '-'
   end subroutine detach

   subroutine set_prompt()
      integer :: g
      character(len=LL) :: tag
      if (trim(st_mode) == 'GAME') then
         g = game_index(st_program)
         tag = st_program
         if (g > 0) then
            if (len_trim(gm_abbrev(g)) > 0) tag = gm_abbrev(g)
         end if
         out_prompt = '['//trim(upcase(tag))//']>'
      else if (trim(st_mode) == 'NORAD-OPS') then
         out_prompt = '[NORAD]>'
      end if
      ! The film shows no indicator at the front door or with Joshua,
      ! so those keep the surface's bare '>' -- no PROMPT block at all.
   end subroutine set_prompt

   ! ================================================================
   ! CALL / REPLY plumbing
   ! ================================================================
   subroutine ask(peer, payload, phase, a1, a2)
      character(len=*), intent(in) :: peer, payload, phase, a1, a2
      call_peer = peer
      n_callp = 1
      call_pay(1) = payload
      st_phase = phase
      st_pa1 = a1
      st_pa2 = a2
   end subroutine ask

   ! A game or processor that could not answer. Returns .true. when it
   ! failed and the period error message has been printed: a subsystem
   ! being down was an ordinary Tuesday in 1983, and the honest
   ! behaviour is a message, not a hang.
   logical function core_failed(gid) result(bad)
      character(len=*), intent(in) :: gid
      character(len=LL) :: reason

      bad = .true.
      if (trim(rp_status) == 'OK') then
         bad = .false.
         return
      end if
      call blank()
      if (trim(rp_status) == 'TIMEOUT') then
         call emit(CORE_TIMEOUT_TEXT)
         return
      end if
      if (trim(rp_status) == 'FAIL') then
         if (rp_n >= 1) then
            select case (trim(rp_line(1)))
            case ('BUSY')
               call emit(CORE_BUSY_TEXT)
               return
            case ('INTERP')
               call emit('UNKNOWN INTERPRETATION: '//trim(upcase(rp_line(2))))
               return
            case ('REFUSED')
               ! The game parsed the frame and DECLARED an error -- a
               ! judgement, and the film's answer to it is a banner, its
               ! underline, and the game's own reason underneath.
               call emit(IMPROPER_1)
               call emit(IMPROPER_2)
               if (rp_n >= 2) then
                  reason = rp_line(2)
                  if (len_trim(reason) > 0) then
                     call blank()
                     call emit(trim(reason))
                  end if
               end if
               return
            case ('FAULT')
               ! Anything else is a genuine fault. Dressing that up in
               ! film flavour would hide it, which is worse than the
               ! raw dump.
               reason = ' '
               if (rp_n >= 2) reason = rp_line(2)
               call emit('ERROR: '//trim(reason))
               return
            end select
         end if
         call emit('ERROR: '//trim(gid))
         return
      end if
      call emit('ERROR: '//trim(gid))
   end function core_failed

   ! The value of a single-line field in the REPLY payload, or blank.
   function payload_field(key) result(val)
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
   end function payload_field

   ! The DISPLAY block inside a REPLY payload: `DISPLAY <n>` followed
   ! by n lines, which are the program's own and pass through verbatim.
   subroutine payload_display(first, count)
      integer, intent(out) :: first, count
      integer :: i
      first = 0
      count = 0
      do i = 1, rp_n
         if (trim(word(rp_line(i), 1)) == 'DISPLAY') then
            count = to_int(word(rp_line(i), 2))
            first = i + 1
            return
         end if
      end do
   end subroutine payload_display

   subroutine emit_payload_display()
      integer :: first, count, i
      call payload_display(first, count)
      if (count <= 0) return
      call blank()
      do i = 0, count - 1
         call emit(trim(rp_line(first + i)))
      end do
   end subroutine emit_payload_display

   ! Park this answer in the COMMAREA: the turn is not over, and the
   ! program that ends here will be restarted with the next one.
   subroutine hold_payload_display()
      integer :: first, count, i
      call payload_display(first, count)
      st_nhold = 0
      do i = 0, count - 1
         st_nhold = st_nhold + 1
         st_hold(st_nhold) = rp_line(first + i)
      end do
   end subroutine hold_payload_display

   subroutine flush_hold()
      integer :: i
      if (st_nhold <= 0) return
      call blank()
      do i = 1, st_nhold
         call emit(trim(st_hold(i)))
      end do
      st_nhold = 0
   end subroutine flush_hold

   logical function terminal_status(s) result(term)
      character(len=*), intent(in) :: s
      select case (trim(s))
      case ('WIN', 'LOSS', 'DRAW', 'NO-WIN', 'ERROR')
         term = .true.
      case default
         term = .false.
      end select
   end function terminal_status

   ! ================================================================
   ! Catalog lookups
   ! ================================================================
   integer function game_index(gid) result(g)
      character(len=*), intent(in) :: gid
      integer :: i
      g = 0
      do i = 1, n_game
         if (trim(gm_id(i)) == trim(gid)) then
            g = i
            return
         end if
      end do
   end function game_index

   ! A LIST/NEW argument names a slot by id or exact title, either case.
   integer function match_slot(arg) result(g)
      character(len=*), intent(in) :: arg
      character(len=LL) :: a
      integer :: i
      a = trim(adjustl(upcase(arg)))
      g = game_index(locase(a))
      if (g > 0) return
      do i = 1, n_game
         if (trim(gm_title(i)) == trim(a)) then
            g = i
            return
         end if
      end do
   end function match_slot

   ! `<TITLE> <n>` / name / author -> interpretation name; '-' = invalid.
   function resolve_selector(gid, sel) result(pin)
      character(len=*), intent(in) :: gid, sel
      character(len=LL) :: pin, s
      integer :: i, n, want

      pin = '-'
      s = trim(adjustl(upcase(sel)))
      n = 0
      do i = 1, n_interp
         if (trim(in_game(i)) == trim(gid)) n = n + 1
      end do
      if (is_digits(s)) then
         want = to_int(s)
         if (n == 0) then
            if (want == 1) pin = 'core'
            return
         end if
         if (want < 1 .or. want > n) return
         n = 0
         do i = 1, n_interp
            if (trim(in_game(i)) /= trim(gid)) cycle
            n = n + 1
            if (n == want) then
               pin = in_name(i)
               return
            end if
         end do
         return
      end if
      if (n == 0) then
         if (trim(s) == 'CORE') pin = 'core'
         return
      end if
      do i = 1, n_interp
         if (trim(in_game(i)) /= trim(gid)) cycle
         if (trim(s) == trim(upcase(in_name(i))) .or. &
             trim(s) == trim(upcase(in_author(i)))) then
            pin = in_name(i)
            return
         end if
      end do
   end function resolve_selector

   ! ================================================================
   ! Writing the response
   ! ================================================================
   subroutine emit(text)
      character(len=*), intent(in) :: text
      if (n_out >= MAXOU) return
      n_out = n_out + 1
      out_line(n_out) = text
   end subroutine emit

   ! The blank line that separates two blocks of the answer. Nothing
   ! separates the first block from what is not there.
   subroutine blank()
      if (n_out == 0) return
      call emit(' ')
   end subroutine blank

   subroutine write_response()
      integer :: i

      write(*, '(A)') 'SYSTEM/1 wopr OK'
      call write_state()
      write(*, '(A,I0)') 'DISPLAY ', n_out
      do i = 1, n_out
         write(*, '(A)') trim(out_line(i))
      end do
      if (trim(call_peer) /= '-') then
         write(*, '(A,I0)') 'CALL '//trim(call_peer)//' ', n_callp
         do i = 1, n_callp
            write(*, '(A)') trim(call_pay(i))
         end do
      else if (trim(out_prompt) /= '-') then
         write(*, '(A)') 'PROMPT '//trim(out_prompt)
      end if
      write(*, '(A)') 'LINE UP'
      write(*, '(A)') 'END'
   end subroutine write_response

   subroutine write_state()
      integer :: n, i
      character(len=LL) :: pend_flag, back_flag

      pend_flag = '-'
      if (trim(st_pending) /= '-') pend_flag = 'PENDING'
      back_flag = '-'
      if (st_backdoor /= 0) back_flag = 'BACKDOOR'
      n = 9 + st_nhold
      if (st_nhold > 0) n = n + 1
      write(*, '(A,I0)') 'STATE ', n
      write(*, '(A)') 'MODE '//trim(st_mode)//' '//trim(st_program)//' '// &
                      trim(pend_flag)//' '//trim(back_flag)
      write(*, '(A)') 'PARENT '//trim(st_parent)
      write(*, '(A,I0)') 'BACKDOOR ', st_backdoor
      write(*, '(A)') 'PENDING '//trim(st_pending)
      write(*, '(A,I0)') 'FAILURES ', st_failures
      write(*, '(A,I0)') 'TURNS ', st_turns
      write(*, '(A)') 'PHASE '//trim(st_phase)
      write(*, '(A)') 'PA1 '//trim(st_pa1)
      write(*, '(A)') 'PA2 '//trim(st_pa2)
      ! HOLD is counted like every other block, and its lines are part
      ! of the STATE count above so the host stores them verbatim.
      if (st_nhold > 0) then
         write(*, '(A,I0)') 'HOLD ', st_nhold
         do i = 1, st_nhold
            write(*, '(A)') trim(st_hold(i))
         end do
      end if
   end subroutine write_state

   subroutine protocol_error(why)
      character(len=*), intent(in) :: why
      write(*, '(A)') 'SYSTEM/1 wopr OK'
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

   function locase(s) result(out)
      character(len=*), intent(in) :: s
      character(len=LL) :: out
      integer :: i, c
      out = s
      do i = 1, len_trim(out)
         c = iachar(out(i:i))
         if (c >= 65 .and. c <= 90) out(i:i) = achar(c + 32)
      end do
   end function locase

   logical function is_digits(s) result(ok)
      character(len=*), intent(in) :: s
      integer :: i, c
      ok = len_trim(s) > 0
      do i = 1, len_trim(s)
         c = iachar(s(i:i))
         if (c < 48 .or. c > 57) then
            ok = .false.
            return
         end if
      end do
   end function is_digits

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
      out = buf
      out = adjustl(out)
   end function itoa

end program wopr
