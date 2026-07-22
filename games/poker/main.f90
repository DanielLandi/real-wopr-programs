!===============================================================================
! WOPR game — POKER (heads-up five-card draw vs W.O.P.R.)
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! Variant (documented approximations, period-simple fixed limit):
!   - Ante 5, fixed bet 10, no raises. Both sides start with 100 chips.
!   - Two betting rounds (before and after the draw); the player acts first
!     in both. Facing a bet the only options are CALL or FOLD.
!   - Draw of 1-3 cards, or STAND PAT (classic house limit of three).
!   - Bets are disallowed (the round checks through) when either stack is
!     under the bet size; every stack delta is a multiple of 5, so the ante
!     is always covered while both stacks are non-zero.
!   - The game ends when a hand resolves with a side at 0 chips. STATUS is
!     from the player's perspective: WIN = W.O.P.R. felted, LOSS = player.
!
! Determinism: the deck is shuffled by a Park-Miller MINSTD LCG (Schrage's
! method, period-authentic) seeded from HAND number + both chip counts at
! DEAL time — never the wall clock. The undealt remainder of the deck is
! carried in the STATE block so draw replacements are reproducible.
!
! W.O.P.R. doctrine (deterministic, own hand only):
!   - Round 1: opens with jacks-or-better pair or any two pair up; calls a
!     bet with any pair or better, folds high card.
!   - Draw: stands pat on straight or better; otherwise keeps paired cards
!     (trips draw 2, two pair draw 1, one pair draws 3); with nothing it
!     keeps the two highest cards and draws 3.
!   - Round 2: bets two pair or better; calls with any pair, folds high card.
!
! State block (7 lines):
!   HAND <n> / CHIPS <player> <wopr> / POT <n> /
!   PHASE <IDLE|BET1|CALL1|DRAW|BET2|CALL2> /
!   PHAND <5 cards|-> / WHAND <5 cards|-> / DECK <k> [k cards]
! Cards are <rank><suit>, ranks 23456789TJQKA, suits CDHS (no Unicode).
!
! Commands:
!   NEW    — fresh game, 100 chips each, awaiting DEAL (STATE 0 in request).
!   MOVE   — requires INPUT: DEAL | BET | CHECK | CALL | FOLD |
!            DRAW <pos...> | STAND PAT   (players=1: no engine-side move,
!            W.O.P.R. answers within the same frame; INPUT omitted = error).
!   QUERY  — re-emit state + situation display without mutating anything.
!
! Period constraints (docs/games.md §7): F90 constructs only, no libraries,
! no wall clock. Memory budget in the manifest.
!===============================================================================
program poker
  implicit none

  character(len=*), parameter :: GAME_ID = 'poker'
  integer, parameter :: ANTE = 5
  integer, parameter :: BET_SIZE = 10
  integer, parameter :: START_CHIPS = 100
  character(len=*), parameter :: RANKS = '23456789TJQKA'
  character(len=*), parameter :: SUITS = 'CDHS'
  character(len=*), parameter :: DRAW_PROMPT = &
       'DRAW 1 TO 3 CARDS (DRAW N N N) OR STAND PAT?'

  integer :: hand_no, pchips, wchips, pot
  character(len=8) :: phase
  character(len=2) :: phand(5), whand(5), deck(52)
  integer :: ndeck
  logical :: in_hand, p_dash, w_dash

  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=64)   :: mv
  logical             :: has_input
  integer             :: nstate, i
  character(len=8)    :: st
  character(len=60)   :: disp(24)
  integer             :: ndisp
  character(len=200)  :: buf

  hand_no = 1
  pchips = START_CHIPS
  wchips = START_CHIPS
  pot = 0
  phase = 'IDLE'
  in_hand = .false.
  ndeck = 0
  phand = '- '
  whand = '- '
  p_dash = .true.
  w_dash = .true.
  has_input = .false.
  mv = ''
  ndisp = 0

  ! ---- request header: WOPR/1 <game_id> <command> ----------------------------
  call read_line(line)
  call parse_header(line, cmd)

  ! ---- STATE block ------------------------------------------------------------
  call read_line(line)
  nstate = parse_count(line)
  if (trim(cmd) == 'NEW') then
     if (nstate /= 0) call die('STATE MUST BE EMPTY FOR NEW')
  else
     if (nstate /= 7) call die('BAD STATE BLOCK')
     do i = 1, 7
        call read_line(line)
        call parse_state_line(i, line)
     end do
     call check_state()
  end if

  ! ---- optional INPUT line, then END -------------------------------------------
  call read_line(line)
  if (len_trim(line) >= 5 .and. line(1:5) == 'INPUT') then
     if (len_trim(line) < 7) call die('INVALID COMMAND')
     mv = adjustl(line(6:))
     has_input = .true.
     call read_line(line)
  end if
  if (trim(line) /= 'END') call die('MISSING END')

  ! ---- dispatch -----------------------------------------------------------------
  select case (trim(cmd))
  case ('NEW')
     call show_new()
  case ('QUERY')
     call show_query()
  case ('MOVE')
     if (.not. has_input) call die('INPUT REQUIRED')
     call do_move(trim(mv))
  end select

  ! ---- status ---------------------------------------------------------------------
  ! A zero stack only ends the game once the hand has resolved (phase IDLE);
  ! mid-hand a side's chips may all be in the pot.
  if (trim(phase) == 'IDLE' .and. pchips == 0) then
     st = 'LOSS'
  else if (trim(phase) == 'IDLE' .and. wchips == 0) then
     st = 'WIN'
  else
     st = 'PLAYING'
  end if

  ! ---- response frame ----------------------------------------------------------------
  write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
  write(*,'(A)') 'STATE 7'
  write(*,'(A)') 'HAND '//trim(itoa(hand_no))
  write(*,'(A)') 'CHIPS '//trim(itoa(pchips))//' '//trim(itoa(wchips))
  write(*,'(A)') 'POT '//trim(itoa(pot))
  write(*,'(A)') 'PHASE '//trim(phase)
  if (in_hand) then
     write(*,'(A)') 'PHAND '//hand_str(phand)
     write(*,'(A)') 'WHAND '//hand_str(whand)
  else
     write(*,'(A)') 'PHAND -'
     write(*,'(A)') 'WHAND -'
  end if
  buf = 'DECK '//trim(itoa(ndeck))
  do i = 1, ndeck
     buf = trim(buf)//' '//deck(i)
  end do
  write(*,'(A)') trim(buf)
  write(*,'(A)') 'DISPLAY '//trim(itoa(ndisp))
  do i = 1, ndisp
     write(*,'(A)') trim(disp(i))
  end do
  write(*,'(A)') 'STATUS '//trim(st)
  if (trim(st) == 'WIN') then
     write(*,'(A)') 'RESULT PLAYER WINS'
  else if (trim(st) == 'LOSS') then
     write(*,'(A)') 'RESULT WOPR WINS'
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

  subroutine parse_state_line(k, l)
    integer, intent(in) :: k
    character(len=*), intent(in) :: l
    integer :: ios
    select case (k)
    case (1)
       if (len_trim(l) < 6 .or. l(1:5) /= 'HAND ') call die('BAD STATE')
       read(l(6:), *, iostat=ios) hand_no
       if (ios /= 0 .or. hand_no < 1) call die('BAD STATE')
    case (2)
       if (len_trim(l) < 7 .or. l(1:6) /= 'CHIPS ') call die('BAD STATE')
       read(l(7:), *, iostat=ios) pchips, wchips
       if (ios /= 0 .or. pchips < 0 .or. wchips < 0) call die('BAD STATE')
    case (3)
       if (len_trim(l) < 5 .or. l(1:4) /= 'POT ') call die('BAD STATE')
       read(l(5:), *, iostat=ios) pot
       if (ios /= 0 .or. pot < 0) call die('BAD STATE')
    case (4)
       if (len_trim(l) < 7 .or. l(1:6) /= 'PHASE ') call die('BAD STATE')
       phase = adjustl(l(7:))
       if (trim(phase) /= 'IDLE'  .and. trim(phase) /= 'BET1' .and. &
           trim(phase) /= 'CALL1' .and. trim(phase) /= 'DRAW' .and. &
           trim(phase) /= 'BET2'  .and. trim(phase) /= 'CALL2') then
          call die('BAD STATE')
       end if
    case (5)
       if (len_trim(l) < 7 .or. l(1:6) /= 'PHAND ') call die('BAD STATE')
       call parse_hand(l(7:), phand, p_dash)
    case (6)
       if (len_trim(l) < 7 .or. l(1:6) /= 'WHAND ') call die('BAD STATE')
       call parse_hand(l(7:), whand, w_dash)
    case (7)
       call parse_deck(l)
    end select
  end subroutine parse_state_line

  subroutine parse_hand(rest, h, dash)
    character(len=*), intent(in)  :: rest
    character(len=2), intent(out) :: h(5)
    logical, intent(out) :: dash
    character(len=64) :: tok
    logical :: found
    integer :: pos, k
    if (trim(adjustl(rest)) == '-') then
       dash = .true.
       h = '- '
       return
    end if
    dash = .false.
    pos = 1
    do k = 1, 5
       call next_tok(rest, pos, tok, found)
       if (.not. found) call die('BAD STATE')
       if (.not. valid_card(tok)) call die('BAD STATE')
       h(k) = tok(1:2)
    end do
    call next_tok(rest, pos, tok, found)
    if (found) call die('BAD STATE')
  end subroutine parse_hand

  subroutine parse_deck(l)
    character(len=*), intent(in) :: l
    character(len=64) :: tok
    logical :: found
    integer :: pos, k, ios
    if (len_trim(l) < 6 .or. l(1:5) /= 'DECK ') call die('BAD STATE')
    pos = 6
    call next_tok(l, pos, tok, found)
    if (.not. found) call die('BAD STATE')
    read(tok, *, iostat=ios) ndeck
    if (ios /= 0 .or. ndeck < 0 .or. ndeck > 42) call die('BAD STATE')
    do k = 1, ndeck
       call next_tok(l, pos, tok, found)
       if (.not. found) call die('BAD STATE')
       if (.not. valid_card(tok)) call die('BAD STATE')
       deck(k) = tok(1:2)
    end do
    call next_tok(l, pos, tok, found)
    if (found) call die('BAD STATE')
  end subroutine parse_deck

  subroutine check_state()
    if (trim(phase) == 'IDLE') then
       if (.not. (p_dash .and. w_dash)) call die('BAD STATE')
       if (ndeck /= 0 .or. pot /= 0) call die('BAD STATE')
       in_hand = .false.
    else
       if (p_dash .or. w_dash) call die('BAD STATE')
       in_hand = .true.
    end if
  end subroutine check_state

  subroutine next_tok(l, pos, tok, found)
    character(len=*), intent(in)    :: l
    integer, intent(inout)          :: pos
    character(len=*), intent(out)   :: tok
    logical, intent(out)            :: found
    integer :: n, s
    n = len_trim(l)
    tok = ''
    do while (pos <= n)
       if (l(pos:pos) /= ' ') exit
       pos = pos + 1
    end do
    if (pos > n) then
       found = .false.
       return
    end if
    s = pos
    do while (pos <= n)
       if (l(pos:pos) == ' ') exit
       pos = pos + 1
    end do
    tok = l(s:pos-1)
    found = .true.
  end subroutine next_tok

  ! -- moves -------------------------------------------------------------------

  subroutine do_move(m)
    character(len=*), intent(in) :: m
    if (trim(phase) == 'IDLE' .and. (pchips == 0 .or. wchips == 0)) then
       call die('GAME ALREADY OVER')
    end if
    select case (trim(phase))
    case ('IDLE')
       if (m == 'DEAL') then
          call deal()
       else
          call die('INVALID COMMAND')
       end if
    case ('BET1')
       if (m == 'BET') then
          call player_bet(1)
       else if (m == 'CHECK') then
          call player_check(1)
       else
          call die('INVALID COMMAND')
       end if
    case ('CALL1')
       if (m == 'CALL') then
          call player_call(1)
       else if (m == 'FOLD') then
          call player_fold()
       else
          call die('INVALID COMMAND')
       end if
    case ('DRAW')
       call do_draw(m)
    case ('BET2')
       if (m == 'BET') then
          call player_bet(2)
       else if (m == 'CHECK') then
          call player_check(2)
       else
          call die('INVALID COMMAND')
       end if
    case ('CALL2')
       if (m == 'CALL') then
          call player_call(2)
       else if (m == 'FOLD') then
          call player_fold()
       else
          call die('INVALID COMMAND')
       end if
    end select
  end subroutine do_move

  subroutine deal()
    integer :: s, i2, j
    character(len=2) :: tmp
    if (pchips < ANTE .or. wchips < ANTE) call die('CANNOT COVER ANTE')
    ! Seed from state only (hand number + chip counts): deterministic.
    s = mod(mod(hand_no, 65521) * 7919 + pchips * 104729 + wchips * 224737, &
            2147483399) + 1
    do i2 = 1, 3
       call lcg_next(s)
    end do
    do i2 = 1, 52
       deck(i2) = card_code(i2)
    end do
    do i2 = 52, 2, -1
       call lcg_next(s)
       j = mod(s, i2) + 1
       tmp = deck(i2)
       deck(i2) = deck(j)
       deck(j) = tmp
    end do
    do i2 = 1, 5
       phand(i2) = deck(i2)
       whand(i2) = deck(i2 + 5)
    end do
    do i2 = 1, 42
       deck(i2) = deck(i2 + 10)
    end do
    ndeck = 42
    call sort_hand(phand)
    call sort_hand(whand)
    pchips = pchips - ANTE
    wchips = wchips - ANTE
    pot = 2 * ANTE
    phase = 'BET1'
    in_hand = .true.
    call add('HAND '//trim(itoa(hand_no))//'. ANTE 5. POT '//trim(itoa(pot))//'.')
    call add('YOUR CARDS: '//hand_str(phand))
    call add('BET OR CHECK?')
  end subroutine deal

  subroutine player_bet(round)
    integer, intent(in) :: round
    integer :: wcat, wtb(5)
    if (pchips < BET_SIZE .or. wchips < BET_SIZE) call die('CANNOT COVER BET')
    pchips = pchips - BET_SIZE
    pot = pot + BET_SIZE
    call eval_hand(whand, wcat, wtb)
    if (wcat >= 1) then
       wchips = wchips - BET_SIZE
       pot = pot + BET_SIZE
       call add('WOPR CALLS. POT '//trim(itoa(pot))//'.')
       if (round == 1) then
          phase = 'DRAW'
          call add(DRAW_PROMPT)
       else
          call showdown()
       end if
    else
       call add('WOPR FOLDS. YOU WIN POT '//trim(itoa(pot))//'.')
       pchips = pchips + pot
       call finish_hand()
    end if
  end subroutine player_bet

  subroutine player_check(round)
    integer, intent(in) :: round
    integer :: wcat, wtb(5)
    logical :: bets
    call eval_hand(whand, wcat, wtb)
    if (round == 1) then
       bets = (wcat >= 2) .or. (wcat == 1 .and. wtb(1) >= 11)
    else
       bets = (wcat >= 2)
    end if
    if (pchips < BET_SIZE .or. wchips < BET_SIZE) bets = .false.
    if (bets) then
       wchips = wchips - BET_SIZE
       pot = pot + BET_SIZE
       call add('WOPR BETS 10. POT '//trim(itoa(pot))//'.')
       call add('CALL OR FOLD?')
       if (round == 1) then
          phase = 'CALL1'
       else
          phase = 'CALL2'
       end if
    else
       call add('WOPR CHECKS.')
       if (round == 1) then
          phase = 'DRAW'
          call add(DRAW_PROMPT)
       else
          call showdown()
       end if
    end if
  end subroutine player_check

  subroutine player_call(round)
    integer, intent(in) :: round
    if (pchips < BET_SIZE) call die('CANNOT COVER BET')
    pchips = pchips - BET_SIZE
    pot = pot + BET_SIZE
    if (round == 1) then
       phase = 'DRAW'
       call add('POT '//trim(itoa(pot))//'.')
       call add(DRAW_PROMPT)
    else
       call showdown()
    end if
  end subroutine player_call

  subroutine player_fold()
    call add('YOU FOLD. WOPR WINS POT '//trim(itoa(pot))//'.')
    wchips = wchips + pot
    call finish_hand()
  end subroutine player_fold

  subroutine do_draw(m)
    character(len=*), intent(in) :: m
    integer :: posns(3), npos, k
    if (m == 'STAND PAT') then
       call add('YOU STAND PAT.')
    else if (len(m) >= 6 .and. m(1:5) == 'DRAW ') then
       call parse_positions(m(6:), posns, npos)
       do k = 1, npos
          phand(posns(k)) = take_card()
       end do
       call sort_hand(phand)
       call add('YOU DRAW '//trim(itoa(npos))//'. YOUR CARDS: '//hand_str(phand))
    else
       call die('INVALID COMMAND')
    end if
    call wopr_draw()
    phase = 'BET2'
    call add('BET OR CHECK?')
  end subroutine do_draw

  subroutine parse_positions(rest, posns, npos)
    character(len=*), intent(in) :: rest
    integer, intent(out) :: posns(3), npos
    character(len=64) :: tok
    logical :: found
    integer :: pos, p, k
    pos = 1
    npos = 0
    posns = 0
    do
       call next_tok(rest, pos, tok, found)
       if (.not. found) exit
       if (len_trim(tok) /= 1) call die('INVALID DRAW')
       if (tok(1:1) < '1' .or. tok(1:1) > '5') call die('INVALID DRAW')
       p = ichar(tok(1:1)) - ichar('0')
       do k = 1, npos
          if (posns(k) == p) call die('INVALID DRAW')
       end do
       npos = npos + 1
       if (npos > 3) call die('INVALID DRAW')
       posns(npos) = p
    end do
    if (npos == 0) call die('INVALID DRAW')
  end subroutine parse_positions

  ! W.O.P.R. draw doctrine: pat on straight or better; keep paired cards;
  ! with nothing keep the two highest (hand is sorted) and draw 3.
  subroutine wopr_draw()
    integer :: wcat, wtb(5), i2, j, cnt, nd
    logical :: keep(5)
    call eval_hand(whand, wcat, wtb)
    keep = .false.
    if (wcat >= 4) then
       keep = .true.
    else if (wcat >= 1) then
       do i2 = 1, 5
          cnt = 0
          do j = 1, 5
             if (rank_of(whand(j)) == rank_of(whand(i2))) cnt = cnt + 1
          end do
          if (cnt >= 2) keep(i2) = .true.
       end do
    else
       keep(1) = .true.
       keep(2) = .true.
    end if
    nd = 0
    do i2 = 1, 5
       if (.not. keep(i2)) then
          whand(i2) = take_card()
          nd = nd + 1
       end if
    end do
    if (nd == 0) then
       call add('WOPR STANDS PAT.')
    else
       call sort_hand(whand)
       call add('WOPR DRAWS '//trim(itoa(nd))//'.')
    end if
  end subroutine wopr_draw

  character(len=2) function take_card() result(c)
    integer :: k
    if (ndeck < 1) call die('DECK EXHAUSTED')
    c = deck(1)
    do k = 1, ndeck - 1
       deck(k) = deck(k + 1)
    end do
    ndeck = ndeck - 1
  end function take_card

  subroutine showdown()
    integer :: pcat, ptb(5), wcat, wtb(5), c, half
    call eval_hand(phand, pcat, ptb)
    call eval_hand(whand, wcat, wtb)
    call add('WOPR SHOWS '//hand_str(whand)//' -- '//trim(cat_name(wcat)))
    call add('YOU SHOW '//hand_str(phand)//' -- '//trim(cat_name(pcat)))
    c = cmp_eval(pcat, ptb, wcat, wtb)
    if (c > 0) then
       call add('YOU WIN POT '//trim(itoa(pot))//'.')
       pchips = pchips + pot
    else if (c < 0) then
       call add('WOPR WINS POT '//trim(itoa(pot))//'.')
       wchips = wchips + pot
    else
       half = pot / 2
       call add('SPLIT POT. EACH TAKES '//trim(itoa(half))//'.')
       pchips = pchips + half
       wchips = wchips + (pot - half)
    end if
    call finish_hand()
  end subroutine showdown

  subroutine finish_hand()
    pot = 0
    ndeck = 0
    in_hand = .false.
    phase = 'IDLE'
    phand = '- '
    whand = '- '
    hand_no = hand_no + 1
    if (pchips == 0) then
       call add('YOU ARE OUT OF CHIPS. WOPR WINS.')
    else if (wchips == 0) then
       call add('WOPR IS OUT OF CHIPS. YOU WIN.')
    else
       call add('CHIPS  YOU '//trim(itoa(pchips))//'  WOPR '//trim(itoa(wchips))//'.')
       call add('TYPE DEAL FOR HAND '//trim(itoa(hand_no))//'.')
    end if
  end subroutine finish_hand

  ! -- displays ----------------------------------------------------------------

  subroutine show_new()
    call add('FIVE CARD DRAW POKER. FIXED LIMIT.')
    call add('ANTE 5. BET 10. YOU AND WOPR START WITH 100 CHIPS.')
    call add('TYPE DEAL FOR HAND 1.')
  end subroutine show_new

  subroutine show_query()
    select case (trim(phase))
    case ('IDLE')
       if (pchips == 0) then
          call add('YOU ARE OUT OF CHIPS. WOPR WINS.')
       else if (wchips == 0) then
          call add('WOPR IS OUT OF CHIPS. YOU WIN.')
       else
          call add('CHIPS  YOU '//trim(itoa(pchips))//'  WOPR '//trim(itoa(wchips))//'.')
          call add('TYPE DEAL FOR HAND '//trim(itoa(hand_no))//'.')
       end if
    case ('BET1', 'BET2')
       call add('YOUR CARDS: '//hand_str(phand))
       call add('POT '//trim(itoa(pot))//'.')
       call add('BET OR CHECK?')
    case ('CALL1', 'CALL2')
       call add('YOUR CARDS: '//hand_str(phand))
       call add('WOPR BETS 10. POT '//trim(itoa(pot))//'.')
       call add('CALL OR FOLD?')
    case ('DRAW')
       call add('YOUR CARDS: '//hand_str(phand))
       call add('POT '//trim(itoa(pot))//'.')
       call add(DRAW_PROMPT)
    end select
  end subroutine show_query

  ! -- cards -------------------------------------------------------------------

  ! Park-Miller MINSTD via Schrage's method: no 32-bit overflow.
  subroutine lcg_next(s)
    integer, intent(inout) :: s
    integer :: k
    k = s / 127773
    s = 16807 * (s - k * 127773) - 2836 * k
    if (s <= 0) s = s + 2147483647
  end subroutine lcg_next

  character(len=2) function card_code(i2) result(c)
    integer, intent(in) :: i2
    integer :: r, u
    r = (i2 - 1) / 4 + 2
    u = mod(i2 - 1, 4) + 1
    c = RANKS(r-1:r-1)//SUITS(u:u)
  end function card_code

  integer function rank_of(c) result(r)
    character(len=2), intent(in) :: c
    r = index(RANKS, c(1:1))
    if (r > 0) r = r + 1
  end function rank_of

  integer function suit_of(c) result(u)
    character(len=2), intent(in) :: c
    u = index(SUITS, c(2:2))
  end function suit_of

  logical function valid_card(t) result(v)
    character(len=*), intent(in) :: t
    v = .false.
    if (len_trim(t) /= 2) return
    if (index(RANKS, t(1:1)) == 0) return
    if (index(SUITS, t(2:2)) == 0) return
    v = .true.
  end function valid_card

  integer function card_key(c) result(k)
    character(len=2), intent(in) :: c
    k = rank_of(c) * 4 + suit_of(c)
  end function card_key

  ! Insertion sort, descending by rank then suit (S>H>D>C): deterministic.
  subroutine sort_hand(h)
    character(len=2), intent(inout) :: h(5)
    integer :: i2, j
    character(len=2) :: t
    do i2 = 2, 5
       t = h(i2)
       j = i2 - 1
       do while (j >= 1)
          if (card_key(h(j)) >= card_key(t)) exit
          h(j+1) = h(j)
          j = j - 1
       end do
       h(j+1) = t
    end do
  end subroutine sort_hand

  character(len=14) function hand_str(h) result(s)
    character(len=2), intent(in) :: h(5)
    s = h(1)//' '//h(2)//' '//h(3)//' '//h(4)//' '//h(5)
  end function hand_str

  ! -- evaluation ---------------------------------------------------------------

  ! Category: 8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight,
  ! 3 trips, 2 two pair, 1 pair, 0 high card. tb() breaks ties left-to-right.
  subroutine eval_hand(h, cat, tb)
    character(len=2), intent(in) :: h(5)
    integer, intent(out) :: cat, tb(5)
    integer :: r(5), cnt(2:14), i2, v
    logical :: flush, straight, distinct
    integer :: hi, quad, trip, p1, p2
    do i2 = 1, 5
       r(i2) = rank_of(h(i2))     ! hand is sorted: r is descending
    end do
    flush = .true.
    do i2 = 2, 5
       if (suit_of(h(i2)) /= suit_of(h(1))) flush = .false.
    end do
    cnt = 0
    do i2 = 1, 5
       cnt(r(i2)) = cnt(r(i2)) + 1
    end do
    quad = 0
    trip = 0
    p1 = 0
    p2 = 0
    do v = 14, 2, -1
       if (cnt(v) == 4) quad = v
       if (cnt(v) == 3) trip = v
       if (cnt(v) == 2) then
          if (p1 == 0) then
             p1 = v
          else
             p2 = v
          end if
       end if
    end do
    distinct = (quad == 0 .and. trip == 0 .and. p1 == 0)
    straight = .false.
    hi = 0
    if (distinct) then
       if (r(1) - r(5) == 4) then
          straight = .true.
          hi = r(1)
       else if (r(1) == 14 .and. r(2) == 5) then
          straight = .true.      ! the wheel A-2-3-4-5, plays five-high
          hi = 5
       end if
    end if
    tb = 0
    if (straight .and. flush) then
       cat = 8
       tb(1) = hi
    else if (quad > 0) then
       cat = 7
       tb(1) = quad
       call kickers(cnt, tb, 2)
    else if (trip > 0 .and. p1 > 0) then
       cat = 6
       tb(1) = trip
       tb(2) = p1
    else if (flush) then
       cat = 5
       tb = r
    else if (straight) then
       cat = 4
       tb(1) = hi
    else if (trip > 0) then
       cat = 3
       tb(1) = trip
       call kickers(cnt, tb, 2)
    else if (p2 > 0) then
       cat = 2
       tb(1) = p1
       tb(2) = p2
       call kickers(cnt, tb, 3)
    else if (p1 > 0) then
       cat = 1
       tb(1) = p1
       call kickers(cnt, tb, 2)
    else
       cat = 0
       tb = r
    end if
  end subroutine eval_hand

  ! Append the unpaired ranks, descending, starting at tb(kstart).
  subroutine kickers(cnt, tb, kstart)
    integer, intent(in)    :: cnt(2:14)
    integer, intent(inout) :: tb(5)
    integer, intent(in)    :: kstart
    integer :: v, k
    k = kstart
    do v = 14, 2, -1
       if (cnt(v) == 1) then
          tb(k) = v
          k = k + 1
       end if
    end do
  end subroutine kickers

  integer function cmp_eval(ca, ta, cb, tbv) result(c)
    integer, intent(in) :: ca, ta(5), cb, tbv(5)
    integer :: i2
    if (ca > cb) then
       c = 1
       return
    else if (ca < cb) then
       c = -1
       return
    end if
    do i2 = 1, 5
       if (ta(i2) > tbv(i2)) then
          c = 1
          return
       else if (ta(i2) < tbv(i2)) then
          c = -1
          return
       end if
    end do
    c = 0
  end function cmp_eval

  character(len=15) function cat_name(cat) result(nm)
    integer, intent(in) :: cat
    select case (cat)
    case (8)
       nm = 'STRAIGHT FLUSH'
    case (7)
       nm = 'FOUR OF A KIND'
    case (6)
       nm = 'FULL HOUSE'
    case (5)
       nm = 'FLUSH'
    case (4)
       nm = 'STRAIGHT'
    case (3)
       nm = 'THREE OF A KIND'
    case (2)
       nm = 'TWO PAIR'
    case (1)
       nm = 'ONE PAIR'
    case default
       nm = 'HIGH CARD'
    end select
  end function cat_name

  ! -- plumbing ----------------------------------------------------------------

  subroutine add(s)
    character(len=*), intent(in) :: s
    ndisp = ndisp + 1
    disp(ndisp) = s
  end subroutine add

  character(len=12) function itoa(n) result(s)
    integer, intent(in) :: n
    write(s, '(I0)') n
  end function itoa

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

end program poker
