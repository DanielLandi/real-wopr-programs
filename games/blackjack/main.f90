!===============================================================================
! WOPR game — BLACK JACK
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! Deck: a single 52-card deck, reshuffled for every hand. The shuffle is a
! Fisher-Yates driven by a Lehmer multiplicative LCG (a=16807, m=2**31-1,
! computed with Schrage's factorization to stay in 32-bit integers — the
! generator of Lewis/Goodman/Miller, IBM/360, 1969). The seed derives from
! the STATE (hand number + chip count), never the wall clock, so the same
! state + input always deals the same cards, byte-exact. Chips only change
! when a hand resolves, so the seed is stable across DEAL/HIT/STAND within
! a hand and the deck is reconstructed identically on every call.
!
! Rules (period-simple casino):
!   - fixed bet 10, starting stake 100
!   - dealer stands on ALL 17s (soft 17 included)
!   - a natural (2-card 21) pays 3:2 (+15); both natural is a push
!   - no split, no double, no insurance
! Terminal conditions (STATUS is from the player's perspective):
!   - chips < 10  (cannot cover the bet)  -> STATUS LOSS
!   - chips >= 200 (house limit reached)  -> STATUS WIN
!   Per-hand outcomes are reported in the DISPLAY block only.
!
! State block (5 lines, opaque outside this game):
!   CHIPS <n>
!   HAND <n>                        hands dealt so far
!   PHASE BETWEEN|PLAYER            between hands / player to act
!   PLAYER <cards|->                e.g. PLAYER AH 9C   ("-" when no hand)
!   DEALER <cards|->                dealer holds exactly 2 during PLAYER phase
!   Cards are rank+suit: ranks A 2-9 T J Q K, suits S H D C (T = ten).
!
! Commands:
!   NEW    — stake 100, no hand dealt (STATE 0 in the request).
!   MOVE   — with "INPUT DEAL":  deal the next hand (BETWEEN phase only).
!            with "INPUT HIT":   draw a card (PLAYER phase only).
!            with "INPUT STAND": dealer plays out, hand resolves.
!            with INPUT omitted: the engine plays for the player — DEAL when
!            between hands, otherwise HIT below 17 and STAND at 17 or more.
!   QUERY  — re-emit state + display without mutating anything.
!
! Period constraints (docs/games.md §7): F77/F90 constructs only, no
! libraries, no wall clock. Memory budget in the manifest.
!===============================================================================
program blackjack
  implicit none

  character(len=*), parameter :: GAME_ID = 'blackjack'
  integer, parameter :: START_CHIPS = 100
  integer, parameter :: BET         = 10
  integer, parameter :: HOUSE_LIMIT = 200
  integer, parameter :: MAX_CARDS   = 16

  integer             :: chips, hand
  character(len=8)    :: phase
  integer             :: pl(MAX_CARDS), np
  integer             :: dl(MAX_CARDS), nd
  integer             :: deck(52)
  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=64)   :: mv_str
  logical             :: has_input, resolved
  character(len=60)   :: msg
  integer             :: nstate, pt, dt
  character(len=8)    :: st

  chips = START_CHIPS
  hand  = 0
  phase = 'BETWEEN'
  np = 0
  nd = 0
  has_input = .false.
  resolved  = .false.
  mv_str = ''
  msg    = ''

  ! ---- request header: WOPR/1 <game_id> <command> ----------------------------
  call read_line(line)
  call parse_header(line, cmd)

  ! ---- STATE block ------------------------------------------------------------
  call read_line(line)
  nstate = parse_count(line)
  if (trim(cmd) == 'NEW') then
     if (nstate /= 0) call die('STATE MUST BE EMPTY FOR NEW')
  else
     if (nstate /= 5) call die('BAD STATE BLOCK')
     call read_line(line)
     chips = parse_int_field(line, 'CHIPS ')
     call read_line(line)
     hand = parse_int_field(line, 'HAND ')
     call read_line(line)
     call parse_phase(line)
     call read_line(line)
     call parse_cards(line, 'PLAYER ', pl, np)
     call read_line(line)
     call parse_cards(line, 'DEALER ', dl, nd)
     call check_state()
  end if

  ! ---- optional INPUT line, then END ------------------------------------------
  call read_line(line)
  if (len_trim(line) >= 5 .and. line(1:5) == 'INPUT') then
     if (len_trim(line) < 7) call die('INVALID INPUT')
     mv_str = adjustl(line(6:))
     has_input = .true.
     call read_line(line)
  end if
  if (trim(line) /= 'END') call die('MISSING END')

  ! ---- dispatch ----------------------------------------------------------------
  select case (trim(cmd))
  case ('NEW')
     ! fresh stake already initialized
  case ('QUERY')
     ! no mutation
  case ('MOVE')
     if (status_of(chips) /= 'PLAYING') call die('GAME ALREADY OVER')
     if (.not. has_input) then
        ! Engine plays for the player: deal, then hit to 17.
        if (trim(phase) == 'BETWEEN') then
           mv_str = 'DEAL'
        else if (hand_total(pl, np) < 17) then
           mv_str = 'HIT'
        else
           mv_str = 'STAND'
        end if
     end if
     select case (trim(mv_str))
     case ('DEAL')
        if (trim(phase) /= 'BETWEEN') call die('HAND IN PROGRESS')
        call do_deal()
     case ('HIT')
        if (trim(phase) /= 'PLAYER') call die('NO HAND IN PROGRESS')
        call do_hit()
     case ('STAND')
        if (trim(phase) /= 'PLAYER') call die('NO HAND IN PROGRESS')
        call do_stand()
     case default
        call die('UNKNOWN INPUT')
     end select
  end select

  st = status_of(chips)

  ! ---- response frame ----------------------------------------------------------
  write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
  write(*,'(A)') 'STATE 5'
  write(*,'(A)') 'CHIPS '//trim(itoa(chips))
  write(*,'(A)') 'HAND '//trim(itoa(hand))
  write(*,'(A)') 'PHASE '//trim(phase)
  if (trim(phase) == 'PLAYER') then
     write(*,'(A)') 'PLAYER '//trim(cards_line(pl, np))
     write(*,'(A)') 'DEALER '//trim(cards_line(dl, nd))
  else
     write(*,'(A)') 'PLAYER -'
     write(*,'(A)') 'DEALER -'
  end if

  if (resolved) then
     pt = hand_total(pl, np)
     dt = hand_total(dl, nd)
     write(*,'(A)') 'DISPLAY 4'
     write(*,'(A)') trim(header_line())
     write(*,'(A)') 'DEALER: '//trim(cards_line(dl, nd))//' ('//trim(itoa(dt))//')'
     write(*,'(A)') 'PLAYER: '//trim(cards_line(pl, np))//' ('//trim(itoa(pt))//')'
     write(*,'(A)') trim(msg)
  else if (trim(phase) == 'PLAYER') then
     pt = hand_total(pl, np)
     write(*,'(A)') 'DISPLAY 4'
     write(*,'(A)') trim(header_line())
     write(*,'(A)') 'DEALER: '//card_str(dl(1))//' ??'
     write(*,'(A)') 'PLAYER: '//trim(cards_line(pl, np))//' ('//trim(itoa(pt))//')'
     write(*,'(A)') 'HIT OR STAND?'
  else if (hand == 0) then
     write(*,'(A)') 'DISPLAY 3'
     write(*,'(A)') 'BLACK JACK'
     write(*,'(A)') 'CHIPS '//trim(itoa(chips))//'  BET '//trim(itoa(BET))//' PER HAND'
     write(*,'(A)') 'TYPE DEAL TO BEGIN'
  else
     write(*,'(A)') 'DISPLAY 2'
     write(*,'(A)') 'CHIPS '//trim(itoa(chips))//'  BET '//trim(itoa(BET))//' PER HAND'
     write(*,'(A)') 'TYPE DEAL FOR NEXT HAND'
  end if

  write(*,'(A)') 'STATUS '//trim(st)
  select case (trim(st))
  case ('WIN')
     write(*,'(A)') 'RESULT HOUSE LIMIT REACHED. YOU BEAT THE HOUSE.'
  case ('LOSS')
     write(*,'(A)') 'RESULT OUT OF CHIPS. THE HOUSE WINS.'
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

  integer function parse_int_field(l, key) result(v)
    character(len=*), intent(in) :: l, key
    integer :: ios, k
    k = len(key)
    v = -1
    if (len_trim(l) <= k .or. l(1:k) /= key) call die('BAD STATE LINE')
    read(l(k+1:), *, iostat=ios) v
    if (ios /= 0 .or. v < 0) call die('BAD STATE LINE')
  end function parse_int_field

  subroutine parse_phase(l)
    character(len=*), intent(in) :: l
    if (trim(l) == 'PHASE BETWEEN') then
       phase = 'BETWEEN'
    else if (trim(l) == 'PHASE PLAYER') then
       phase = 'PLAYER'
    else
       call die('BAD PHASE LINE')
    end if
  end subroutine parse_phase

  ! Parse "<key><cards|->" into an index array. Cards are 2-char rank+suit
  ! tokens separated by blanks; "-" means an empty hand.
  subroutine parse_cards(l, key, arr, n)
    character(len=*), intent(in)  :: l, key
    integer, intent(out) :: arr(MAX_CARDS), n
    character(len=1024) :: rest
    character(len=64)   :: tok
    integer :: k, s
    k = len(key)
    n = 0
    if (len_trim(l) <= k .or. l(1:k) /= key) call die('BAD STATE LINE')
    rest = adjustl(l(k+1:))
    if (trim(rest) == '-') return
    do while (len_trim(rest) > 0)
       s = index(trim(rest), ' ')
       if (s == 0) then
          tok = trim(rest)
          rest = ''
       else
          tok = rest(1:s-1)
          rest = adjustl(rest(s+1:))
       end if
       n = n + 1
       if (n > MAX_CARDS) call die('BAD STATE LINE')
       arr(n) = parse_card(tok)
    end do
  end subroutine parse_cards

  integer function parse_card(tok) result(c)
    character(len=*), intent(in) :: tok
    character(len=13), parameter :: RANKS = 'A23456789TJQK'
    character(len=4),  parameter :: SUITS = 'SHDC'
    integer :: r, s
    c = -1
    if (len_trim(tok) /= 2) call die('BAD CARD')
    r = index(RANKS, tok(1:1))
    s = index(SUITS, tok(2:2))
    if (r == 0 .or. s == 0) call die('BAD CARD')
    c = (s - 1) * 13 + (r - 1)
  end function parse_card

  ! Structural invariants of a parsed state (the block is otherwise opaque).
  subroutine check_state()
    if (trim(phase) == 'BETWEEN') then
       if (np /= 0 .or. nd /= 0) call die('BAD STATE BLOCK')
    else
       if (np < 2 .or. nd /= 2) call die('BAD STATE BLOCK')
    end if
  end subroutine check_state

  character(len=8) function status_of(c) result(s)
    integer, intent(in) :: c
    if (c < BET) then
       s = 'LOSS'
    else if (c >= HOUSE_LIMIT) then
       s = 'WIN'
    else
       s = 'PLAYING'
    end if
  end function status_of

  ! Lehmer LCG step: s <- 16807*s mod (2**31-1), Schrage's factorization.
  subroutine lcg_next(s)
    integer, intent(inout) :: s
    integer :: k
    k = s / 127773
    s = 16807 * (s - k * 127773) - 2836 * k
    if (s < 0) s = s + 2147483647
  end subroutine lcg_next

  ! Rebuild this hand's deck from the state. Chips only change on hand
  ! resolution, so DEAL/HIT/STAND within one hand all see the same deck.
  subroutine build_deck()
    integer :: s, i, j, t
    s = mod(hand * 7919 + chips * 271, 2147483646) + 1
    do i = 1, 52
       deck(i) = i - 1
    end do
    do i = 52, 2, -1
       call lcg_next(s)
       j = 1 + mod(s, i)
       t = deck(i)
       deck(i) = deck(j)
       deck(j) = t
    end do
  end subroutine build_deck

  ! Best blackjack total: aces count 11, downgraded to 1 while over 21.
  integer function hand_total(arr, n) result(t)
    integer, intent(in) :: arr(MAX_CARDS), n
    integer :: i, r, aces
    t = 0
    aces = 0
    do i = 1, n
       r = mod(arr(i), 13)
       if (r == 0) then
          t = t + 11
          aces = aces + 1
       else if (r >= 9) then
          t = t + 10
       else
          t = t + r + 1
       end if
    end do
    do while (t > 21 .and. aces > 0)
       t = t - 10
       aces = aces - 1
    end do
  end function hand_total

  subroutine do_deal()
    integer :: p2, d2
    hand = hand + 1
    call build_deck()
    np = 2
    nd = 2
    pl(1) = deck(1)
    pl(2) = deck(2)
    dl(1) = deck(3)
    dl(2) = deck(4)
    p2 = hand_total(pl, np)
    d2 = hand_total(dl, nd)
    if (p2 == 21 .and. d2 == 21) then
       call resolve(0, 'PUSH. BOTH BLACKJACK')
    else if (p2 == 21) then
       call resolve(BET + BET / 2, 'BLACKJACK. YOU WIN '//trim(itoa(BET + BET / 2)))
    else if (d2 == 21) then
       call resolve(-BET, 'DEALER BLACKJACK. YOU LOSE '//trim(itoa(BET)))
    else
       phase = 'PLAYER'
    end if
  end subroutine do_deal

  subroutine do_hit()
    integer :: pos
    call build_deck()
    pos = np + nd + 1
    if (pos > 52) call die('DECK EXHAUSTED')
    np = np + 1
    pl(np) = deck(pos)
    if (hand_total(pl, np) > 21) then
       call resolve(-BET, 'BUST. YOU LOSE '//trim(itoa(BET)))
    end if
  end subroutine do_hit

  subroutine do_stand()
    integer :: pos, p, d
    call build_deck()
    pos = np + nd
    do
       d = hand_total(dl, nd)
       if (d >= 17) exit               ! dealer stands on all 17s, soft included
       pos = pos + 1
       if (pos > 52) call die('DECK EXHAUSTED')
       nd = nd + 1
       dl(nd) = deck(pos)
    end do
    p = hand_total(pl, np)
    if (d > 21) then
       call resolve(BET, 'DEALER BUSTS. YOU WIN '//trim(itoa(BET)))
    else if (p > d) then
       call resolve(BET, 'YOU WIN '//trim(itoa(BET)))
    else if (p < d) then
       call resolve(-BET, 'YOU LOSE '//trim(itoa(BET)))
    else
       call resolve(0, 'PUSH. BET RETURNED')
    end if
  end subroutine do_stand

  subroutine resolve(delta, m)
    integer, intent(in) :: delta
    character(len=*), intent(in) :: m
    chips = chips + delta
    msg = m
    resolved = .true.
    phase = 'BETWEEN'
    ! Card arrays stay populated for this response's DISPLAY; the emitted
    ! STATE clears them ("-") because the phase is back to BETWEEN.
  end subroutine resolve

  character(len=60) function header_line() result(h)
    h = 'HAND '//trim(itoa(hand))//'  CHIPS '//trim(itoa(chips))// &
        '  BET '//trim(itoa(BET))
  end function header_line

  character(len=48) function cards_line(arr, n) result(s)
    integer, intent(in) :: arr(MAX_CARDS), n
    integer :: i
    s = ''
    do i = 1, n
       if (i == 1) then
          s = card_str(arr(i))
       else
          s = trim(s)//' '//card_str(arr(i))
       end if
    end do
  end function cards_line

  character(len=2) function card_str(c) result(s)
    integer, intent(in) :: c
    character(len=13), parameter :: RANKS = 'A23456789TJQK'
    character(len=4),  parameter :: SUITS = 'SHDC'
    integer :: r, su
    r = mod(c, 13) + 1
    su = c / 13 + 1
    s = RANKS(r:r)//SUITS(su:su)
  end function card_str

  character(len=12) function itoa(n) result(s)
    integer, intent(in) :: n
    write(s, '(I12)') n
    s = adjustl(s)
  end function itoa

  ! Emit a well-formed ERROR frame and exit non-zero (docs/games.md §2.3).
  subroutine die(m)
    character(len=*), intent(in) :: m
    write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
    write(*,'(A)') 'STATE 0'
    write(*,'(A)') 'DISPLAY 0'
    write(*,'(A)') 'STATUS ERROR'
    write(*,'(A)') 'RESULT '//m
    write(*,'(A)') 'END'
    stop 1
  end subroutine die

end program blackjack
