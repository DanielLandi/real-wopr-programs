!===============================================================================
! WOPR game — HEARTS
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! Four hands: the human is SOUTH; W.O.P.R. plays WEST, NORTH and EAST. Play
! order is SOUTH, WEST, NORTH, EAST. After every card the human plays, the
! W.O.P.R. seats answer, tricks resolve, hands score, and the next hand is
! dealt — all within the same MOVE frame — until SOUTH is to play again or
! the game ends (players=1, like poker: MOVE always requires INPUT).
!
! Variant (documented, period-simple casual rules):
!   - No passing phase, so the input grammar stays card plays only.
!   - The holder of the two of clubs leads it to trick one.
!   - No points on the first trick (unless a hand is all point cards).
!   - Hearts may not LEAD until broken (unless the hand is only hearts).
!     Any heart played breaks hearts; the queen of spades does not break
!     hearts and may be led at any time.
!   - Hearts score 1 each, the queen of spades 13. Taking all 26 shoots
!     the moon: 26 to each opponent instead.
!   - A hand ending with any total at 100 or more ends the game; the LOWEST
!     total wins. STATUS is from SOUTH's perspective: WIN only if SOUTH is
!     strictly lowest; ties go to the machine.
!
! Determinism: the deal is a Fisher-Yates shuffle driven by a Lehmer
! multiplicative LCG (a=16807, m=2**31-1, Schrage's factorization — the
! Lewis/Goodman/Miller generator, as in blackjack), seeded from the hand
! number plus all four scores. Scores only change between hands, so the seed
! is stable; hands ride in the STATE block, so nothing is reconstructed
! mid-hand. No wall clock anywhere.
!
! W.O.P.R. seat doctrine (deterministic, own hand only):
!   - Leading: the two of clubs on trick one; otherwise the lowest non-heart
!     by rank (suit order C,D,S on ties); hearts only when nothing else
!     remains (never leads hearts by choice, broken or not).
!   - Following suit: the highest card that still loses the trick ("duck
!     high"); forced to win, the lowest card of the suit (cheapest win).
!   - Void: on trick one the highest non-point card; otherwise the queen of
!     spades if held, else the highest heart, else the highest card overall
!     (rank first, suit order C,D,S on ties).
!
! State block (10 lines, opaque outside this game):
!   HAND <n>                      current hand number, 1-based
!   SCORES <s> <w> <n> <e>        game totals, order SOUTH WEST NORTH EAST
!   TAKEN <s> <w> <n> <e>         points taken so far this hand
!   LEAD <seat>                   who led the current trick
!   TRICK <cards|->               cards played to the trick, in play order
!   BROKEN Y|N                    hearts broken this hand
!   SOUTH <cards|->               remaining hands, sorted C,D,S,H, rank asc
!   WEST <cards|->
!   NORTH <cards|->
!   EAST <cards|->
!   Cards are rank+suit: ranks 2-9 T J Q K A (T = ten), suits C D S H.
!   A non-terminal state is always SOUTH to play; when any score reaches
!   100 the hands are empty and the state is terminal.
!
! Commands:
!   NEW    — deal hand one; W.O.P.R. seats play up to SOUTH's first turn.
!   MOVE   — requires "INPUT <card>" (e.g. QS or TH).
!   QUERY  — re-emit state + situation display without mutating anything.
!
! Rule violations (bad card, card not held, not following suit, leading
! hearts unbroken, points on trick one) return a well-formed ERROR frame and
! exit non-zero like the other catalog games; the bridge keeps the stored
! state unchanged, so the hand simply continues on the next input.
!
! Period constraints (docs/games.md §7): F77/F90 constructs only, no
! libraries, no wall clock. Memory budget in the manifest.
!===============================================================================
program hearts
  implicit none

  character(len=*), parameter :: GAME_ID = 'hearts'
  character(len=13), parameter :: RANKS = '23456789TJQKA'
  character(len=4),  parameter :: SUITS = 'CDSH'
  integer, parameter :: LIMIT   = 100
  integer, parameter :: CARD_2C = 0     ! (C-1)*13 + (rank 2 - 1)
  integer, parameter :: CARD_QS = 36    ! (S-1)*13 + (rank Q - 1)
  integer, parameter :: MAXD    = 24

  character(len=5), parameter :: SEAT_NAME(4) = &
       [ character(len=5) :: 'SOUTH', 'WEST', 'NORTH', 'EAST' ]
  character(len=8), parameter :: SUIT_NAME(4) = &
       [ character(len=8) :: 'CLUBS', 'DIAMONDS', 'SPADES', 'HEARTS' ]

  integer :: hand_no
  integer :: scores(4), taken(4)
  integer :: hands(13, 4), nh(4)
  integer :: trick(4), ntr, lead
  logical :: broken

  character(len=1024) :: line
  character(len=8)    :: cmd
  character(len=64)   :: mv_str
  logical             :: has_input
  integer             :: nstate, mcard, i
  character(len=8)    :: st
  character(len=60)   :: disp(MAXD)
  integer             :: ndisp
  logical             :: pend_broken

  hand_no = 1
  scores = 0
  taken  = 0
  nh     = 0
  ntr    = 0
  lead   = 1
  broken = .false.
  has_input = .false.
  mv_str = ''
  ndisp  = 0
  pend_broken = .false.

  ! ---- request header: WOPR/1 <game_id> <command> ----------------------------
  call read_line(line)
  call parse_header(line, cmd)

  ! ---- STATE block ------------------------------------------------------------
  call read_line(line)
  nstate = parse_count(line)
  if (trim(cmd) == 'NEW') then
     if (nstate /= 0) call die('STATE MUST BE EMPTY FOR NEW')
  else
     if (nstate /= 10) call die('BAD STATE BLOCK')
     call read_line(line)
     hand_no = parse_int_field(line, 'HAND ')
     call read_line(line)
     call parse_four(line, 'SCORES ', scores)
     call read_line(line)
     call parse_four(line, 'TAKEN ', taken)
     call read_line(line)
     call parse_lead(line)
     call read_line(line)
     call parse_cards(line, 'TRICK ', trick, ntr, 4)
     call read_line(line)
     call parse_broken(line)
     call read_line(line)
     call parse_cards(line, 'SOUTH ', hands(:, 1), nh(1), 13)
     call read_line(line)
     call parse_cards(line, 'WEST ', hands(:, 2), nh(2), 13)
     call read_line(line)
     call parse_cards(line, 'NORTH ', hands(:, 3), nh(3), 13)
     call read_line(line)
     call parse_cards(line, 'EAST ', hands(:, 4), nh(4), 13)
     call check_state()
  end if

  ! ---- optional INPUT line, then END ------------------------------------------
  call read_line(line)
  if (len_trim(line) >= 5 .and. line(1:5) == 'INPUT') then
     if (len_trim(line) < 7) call die('BAD CARD - USE RANK AND SUIT, E.G. QS OR TH')
     mv_str = adjustl(line(6:))
     has_input = .true.
     call read_line(line)
  end if
  if (trim(line) /= 'END') call die('MISSING END')

  ! ---- dispatch ----------------------------------------------------------------
  select case (trim(cmd))
  case ('NEW')
     call deal_hand()
     call add_disp('HEARTS <3 <3 <3 HAND 1')
     call add_disp('YOU ARE SOUTH. JOSHUA PLAYS WEST, NORTH, EAST.')
     call add_disp('CARDS ARE RANK+SUIT')
     call add_disp('    RANKS: 2-9 T J Q K A (T = TEN)')
     call add_disp('    SUITS: C CLUBS D DIAMONDS S SPADES H HEARTS')
     call advance()
     call present_position()
  case ('QUERY')
     if (terminal()) then
        call add_disp('HEARTS <3 <3 <3 HAND '//trim(itoa(hand_no)))
        call add_disp('FINAL: '//trim(tally(scores)))
     else
        call add_disp('HEARTS <3 <3 <3 HAND '//trim(itoa(hand_no))//'  TRICK '// &
                      trim(itoa(cur_trick())))
        call add_disp('SCORE: '//trim(tally(scores)))
        call present_position()
     end if
  case ('MOVE')
     if (terminal()) call die('GAME ALREADY OVER')
     if (.not. has_input) call die('INPUT REQUIRED')
     mcard = card_of(trim(mv_str))
     if (mcard < 0) call die('BAD CARD - USE RANK AND SUIT, E.G. QS OR TH')
     call validate_south(mcard)
     call play_card(1, mcard)
     call advance()
     if (.not. terminal()) call present_position()
  end select

  if (terminal()) then
     if (south_wins()) then
        st = 'WIN'
     else
        st = 'LOSS'
     end if
  else
     st = 'PLAYING'
  end if

  ! ---- response frame ----------------------------------------------------------
  write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
  write(*,'(A)') 'STATE 10'
  write(*,'(A)') 'HAND '//trim(itoa(hand_no))
  write(*,'(A)') 'SCORES '//trim(four(scores))
  write(*,'(A)') 'TAKEN '//trim(four(taken))
  write(*,'(A)') 'LEAD '//trim(SEAT_NAME(lead))
  write(*,'(A)') 'TRICK '//trim(card_field(trick, ntr))
  if (broken) then
     write(*,'(A)') 'BROKEN Y'
  else
     write(*,'(A)') 'BROKEN N'
  end if
  write(*,'(A)') 'SOUTH '//trim(card_field(hands(:, 1), nh(1)))
  write(*,'(A)') 'WEST '//trim(card_field(hands(:, 2), nh(2)))
  write(*,'(A)') 'NORTH '//trim(card_field(hands(:, 3), nh(3)))
  write(*,'(A)') 'EAST '//trim(card_field(hands(:, 4), nh(4)))

  write(*,'(A)') 'DISPLAY '//trim(itoa(ndisp))
  do i = 1, ndisp
     write(*,'(A)') trim(disp(i))
  end do

  write(*,'(A)') 'STATUS '//trim(st)
  if (terminal()) then
     write(*,'(A)') 'RESULT '//trim(SEAT_NAME(winner_seat()))//' WINS WITH '// &
                    trim(itoa(scores(winner_seat())))//' POINTS.'
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

  integer function parse_int_field(l, key) result(v)
    character(len=*), intent(in) :: l, key
    integer :: ios, k
    k = len(key)
    v = -1
    if (len_trim(l) <= k .or. l(1:k) /= key) call die('BAD STATE LINE')
    read(l(k+1:), *, iostat=ios) v
    if (ios /= 0 .or. v < 0) call die('BAD STATE LINE')
  end function parse_int_field

  subroutine parse_four(l, key, v)
    character(len=*), intent(in) :: l, key
    integer, intent(out) :: v(4)
    integer :: ios, k, j
    k = len(key)
    if (len_trim(l) <= k .or. l(1:k) /= key) call die('BAD STATE LINE')
    read(l(k+1:), *, iostat=ios) v
    if (ios /= 0) call die('BAD STATE LINE')
    do j = 1, 4
       if (v(j) < 0 .or. v(j) > 999) call die('BAD STATE LINE')
    end do
  end subroutine parse_four

  subroutine parse_lead(l)
    character(len=*), intent(in) :: l
    integer :: s
    if (len_trim(l) <= 5 .or. l(1:5) /= 'LEAD ') call die('BAD STATE LINE')
    lead = 0
    do s = 1, 4
       if (trim(l(6:)) == trim(SEAT_NAME(s))) lead = s
    end do
    if (lead == 0) call die('BAD STATE LINE')
  end subroutine parse_lead

  subroutine parse_broken(l)
    character(len=*), intent(in) :: l
    if (trim(l) == 'BROKEN Y') then
       broken = .true.
    else if (trim(l) == 'BROKEN N') then
       broken = .false.
    else
       call die('BAD STATE LINE')
    end if
  end subroutine parse_broken

  ! Parse "<key><cards|->" into an index array ("-" = empty).
  subroutine parse_cards(l, key, arr, n, maxn)
    character(len=*), intent(in)  :: l, key
    integer, intent(in)  :: maxn
    integer, intent(out) :: arr(*), n
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
       if (n > maxn) call die('BAD STATE LINE')
       arr(n) = card_of(trim(tok))
       if (arr(n) < 0) call die('BAD STATE LINE')
    end do
  end subroutine parse_cards

  ! Card token -> 0..51 index, or -1 if malformed. c = (suit-1)*13 + (rank-1),
  ! suits C,D,S,H, ranks 2..A ascending — so ascending indices sort a hand.
  integer function card_of(tok) result(c)
    character(len=*), intent(in) :: tok
    integer :: r, s
    c = -1
    if (len_trim(tok) /= 2) return
    r = index(RANKS, tok(1:1))
    s = index(SUITS, tok(2:2))
    if (r == 0 .or. s == 0) return
    c = (s - 1) * 13 + (r - 1)
  end function card_of

  integer function rank_of(c) result(r)
    integer, intent(in) :: c
    r = mod(c, 13) + 1
  end function rank_of

  integer function suit_of(c) result(s)
    integer, intent(in) :: c
    s = c / 13 + 1
  end function suit_of

  character(len=2) function card_str(c) result(s)
    integer, intent(in) :: c
    s = RANKS(rank_of(c):rank_of(c))//SUITS(suit_of(c):suit_of(c))
  end function card_str

  logical function is_point(c) result(p)
    integer, intent(in) :: c
    p = (suit_of(c) == 4 .or. c == CARD_QS)
  end function is_point

  integer function pts_of(c) result(p)
    integer, intent(in) :: c
    p = 0
    if (suit_of(c) == 4) p = 1
    if (c == CARD_QS) p = 13
  end function pts_of

  logical function terminal() result(t)
    integer :: s
    t = .false.
    do s = 1, 4
       if (scores(s) >= LIMIT) t = .true.
    end do
  end function terminal

  ! Seat playing at position k (0-based) of the current trick.
  integer function seat_at(k) result(s)
    integer, intent(in) :: k
    s = mod(lead - 1 + k, 4) + 1
  end function seat_at

  ! Current trick number, 1..13, from cards not yet played.
  integer function cur_trick() result(t)
    t = (52 - (nh(1) + nh(2) + nh(3) + nh(4)) - ntr) / 4 + 1
  end function cur_trick

  integer function find_in_hand(seat, c) result(k)
    integer, intent(in) :: seat, c
    integer :: i
    k = 0
    do i = 1, nh(seat)
       if (hands(i, seat) == c) k = i
    end do
  end function find_in_hand

  logical function has_suit(seat, s) result(h)
    integer, intent(in) :: seat, s
    integer :: i
    h = .false.
    do i = 1, nh(seat)
       if (suit_of(hands(i, seat)) == s) h = .true.
    end do
  end function has_suit

  logical function has_nonheart(seat) result(h)
    integer, intent(in) :: seat
    integer :: i
    h = .false.
    do i = 1, nh(seat)
       if (suit_of(hands(i, seat)) /= 4) h = .true.
    end do
  end function has_nonheart

  logical function has_nonpoint(seat) result(h)
    integer, intent(in) :: seat
    integer :: i
    h = .false.
    do i = 1, nh(seat)
       if (.not. is_point(hands(i, seat))) h = .true.
    end do
  end function has_nonpoint

  integer function holder_of(c) result(seat)
    integer, intent(in) :: c
    integer :: s
    seat = 1
    do s = 1, 4
       if (find_in_hand(s, c) > 0) seat = s
    end do
  end function holder_of

  ! Structural invariants of a parsed state (the block is otherwise opaque).
  subroutine check_state()
    integer :: s, k, m, p, seen(0:51)
    if (hand_no < 1 .or. hand_no > 999) call die('BAD STATE BLOCK')
    do s = 1, 4
       if (taken(s) > 26) call die('BAD STATE BLOCK')
    end do
    if (taken(1) + taken(2) + taken(3) + taken(4) > 26) call die('BAD STATE BLOCK')
    if (terminal()) then
       if (ntr /= 0) call die('BAD STATE BLOCK')
       do s = 1, 4
          if (nh(s) /= 0) call die('BAD STATE BLOCK')
       end do
       return
    end if
    ! Non-terminal states are always SOUTH to play.
    m = nh(1)
    if (m < 1 .or. m > 13) call die('BAD STATE BLOCK')
    p = mod(5 - lead, 4)
    if (ntr /= p) call die('BAD STATE BLOCK')
    do k = 0, 3
       s = seat_at(k)
       if (s == 1) cycle
       if (k < ntr) then
          if (nh(s) /= m - 1) call die('BAD STATE BLOCK')
       else
          if (nh(s) /= m) call die('BAD STATE BLOCK')
       end if
    end do
    seen = 0
    do s = 1, 4
       do k = 1, nh(s)
          seen(hands(k, s)) = seen(hands(k, s)) + 1
       end do
    end do
    do k = 1, ntr
       seen(trick(k)) = seen(trick(k)) + 1
    end do
    do k = 0, 51
       if (seen(k) > 1) call die('BAD STATE BLOCK')
    end do
    if (cur_trick() == 1) then
       if (ntr == 0) then
          if (lead /= 1 .or. find_in_hand(1, CARD_2C) == 0) call die('BAD STATE BLOCK')
       else
          if (trick(1) /= CARD_2C) call die('BAD STATE BLOCK')
       end if
    end if
  end subroutine check_state

  ! Lehmer LCG step: s <- 16807*s mod (2**31-1), Schrage's factorization.
  subroutine lcg_next(s)
    integer, intent(inout) :: s
    integer :: k
    k = s / 127773
    s = 16807 * (s - k * 127773) - 2836 * k
    if (s < 0) s = s + 2147483647
  end subroutine lcg_next

  ! Deal the current hand. Seeded from hand number + all four scores; scores
  ! only change between hands, so the same state always deals the same cards.
  subroutine deal_hand()
    integer :: s, i, j, t, seat, k, deck(52)
    s = mod(hand_no * 7919 + scores(1) * 271 + scores(2) * 277 + &
            scores(3) * 281 + scores(4) * 283, 2147483646) + 1
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
    do seat = 1, 4
       do k = 1, 13
          hands(k, seat) = deck((seat - 1) * 13 + k)
       end do
       nh(seat) = 13
       call sort_hand(seat)
    end do
    taken  = 0
    ntr    = 0
    broken = .false.
    lead   = holder_of(CARD_2C)
  end subroutine deal_hand

  subroutine sort_hand(seat)
    integer, intent(in) :: seat
    integer :: i, j, v
    do i = 2, nh(seat)
       v = hands(i, seat)
       j = i - 1
       do while (j >= 1)
          if (hands(j, seat) <= v) exit
          hands(j + 1, seat) = hands(j, seat)
          j = j - 1
       end do
       hands(j + 1, seat) = v
    end do
  end subroutine sort_hand

  subroutine remove_card(seat, c)
    integer, intent(in) :: seat, c
    integer :: i, k
    k = find_in_hand(seat, c)
    if (k == 0) call die('CARD NOT IN HAND')
    do i = k, nh(seat) - 1
       hands(i, seat) = hands(i + 1, seat)
    end do
    nh(seat) = nh(seat) - 1
  end subroutine remove_card

  ! ---- play ---------------------------------------------------------------

  subroutine validate_south(c)
    integer, intent(in) :: c
    integer :: led
    if (find_in_hand(1, c) == 0) call die('YOU DO NOT HOLD '//card_str(c))
    if (ntr == 0) then
       if (cur_trick() == 1 .and. c /= CARD_2C) &
            call die('THE TWO OF CLUBS MUST LEAD')
       if (suit_of(c) == 4 .and. .not. broken .and. has_nonheart(1)) &
            call die('HEARTS NOT BROKEN - LEAD ANOTHER SUIT')
    else
       led = suit_of(trick(1))
       if (suit_of(c) /= led) then
          if (has_suit(1, led)) &
               call die('MUST FOLLOW SUIT - '//trim(SUIT_NAME(led))//' LED')
          if (cur_trick() == 1 .and. is_point(c) .and. has_nonpoint(1)) &
               call die('NO POINTS ON THE FIRST TRICK')
       end if
    end if
  end subroutine validate_south

  subroutine play_card(seat, c)
    integer, intent(in) :: seat, c
    call remove_card(seat, c)
    ntr = ntr + 1
    trick(ntr) = c
    if (suit_of(c) == 4 .and. .not. broken) then
       broken = .true.
       pend_broken = .true.
    end if
  end subroutine play_card

  ! Play W.O.P.R. seats and resolve tricks until SOUTH is to play again,
  ! scoring the hand and dealing the next one along the way.
  subroutine advance()
    integer :: seat
    do
       if (ntr == 4) then
          call resolve_trick()
          if (terminal()) return
          cycle
       end if
       seat = seat_at(ntr)
       if (seat == 1) return
       call engine_play(seat)
    end do
  end subroutine advance

  subroutine resolve_trick()
    integer :: k, led, wpos, wr, pts, winner, wcard
    led = suit_of(trick(1))
    wpos = 1
    wr = rank_of(trick(1))
    do k = 2, 4
       if (suit_of(trick(k)) == led .and. rank_of(trick(k)) > wr) then
          wpos = k
          wr = rank_of(trick(k))
       end if
    end do
    winner = seat_at(wpos - 1)
    wcard = trick(wpos)
    pts = 0
    do k = 1, 4
       pts = pts + pts_of(trick(k))
    end do
    taken(winner) = taken(winner) + pts
    ! The completed trick, then who took it and with which card. trick_line
    ! reads trick/ntr, so render it before ntr is cleared below.
    call add_disp(trim(trick_line()))
    call add_disp(trim(seat_disp(winner))//' TAKES THE TRICK WITH '// &
                  card_str(wcard)//'.')
    if (pend_broken) then
       call add_disp('HEARTS ARE BROKEN.')
       pend_broken = .false.
    end if
    lead = winner
    ntr = 0
    if (nh(1) + nh(2) + nh(3) + nh(4) == 0) call score_hand()
  end subroutine resolve_trick

  subroutine score_hand()
    integer :: s, moon
    moon = 0
    do s = 1, 4
       if (taken(s) == 26) moon = s
    end do
    call add_disp('HAND '//trim(itoa(hand_no))//' POINTS: '//trim(tally(taken)))
    if (moon > 0) then
       call add_disp(trim(seat_disp(moon))//' SHOOTS THE MOON. 26 TO EACH OPPONENT.')
       do s = 1, 4
          if (s /= moon) scores(s) = scores(s) + 26
       end do
    else
       do s = 1, 4
          scores(s) = scores(s) + taken(s)
       end do
    end if
    if (terminal()) then
       call add_disp('FINAL: '//trim(tally(scores)))
    else
       call add_disp('SCORE: '//trim(tally(scores)))
       hand_no = hand_no + 1
       call deal_hand()
       call add_disp('HAND '//trim(itoa(hand_no))//' DEALT.')
    end if
  end subroutine score_hand

  subroutine engine_play(seat)
    integer, intent(in) :: seat
    call play_card(seat, choose_card(seat))
  end subroutine engine_play

  ! Deterministic seat doctrine (see header). Reads only this seat's hand
  ! plus the public trick. Tie-breaks: rank first, suit order C,D,S,H.
  integer function choose_card(seat) result(c)
    integer, intent(in) :: seat
    integer :: i, cd, led, w, k, key, bkey
    c = -1
    if (ntr == 0) then
       if (cur_trick() == 1) then
          c = CARD_2C
          return
       end if
       bkey = 999999
       do i = 1, nh(seat)
          cd = hands(i, seat)
          if (suit_of(cd) /= 4) then
             key = (rank_of(cd) - 1) * 4 + suit_of(cd)
             if (key < bkey) then
                bkey = key
                c = cd
             end if
          end if
       end do
       if (c >= 0) return
       c = hands(1, seat)                  ! only hearts: lowest heart
       return
    end if
    led = suit_of(trick(1))
    w = 0
    do k = 1, ntr
       if (suit_of(trick(k)) == led .and. rank_of(trick(k)) > w) w = rank_of(trick(k))
    end do
    if (has_suit(seat, led)) then
       do i = 1, nh(seat)                  ! ascending: last loser = highest
          cd = hands(i, seat)
          if (suit_of(cd) == led .and. rank_of(cd) < w) c = cd
       end do
       if (c >= 0) return
       do i = 1, nh(seat)                  ! forced to win: cheapest win
          cd = hands(i, seat)
          if (suit_of(cd) == led) then
             c = cd
             return
          end if
       end do
    end if
    if (cur_trick() == 1) then             ! void on trick one: no points
       bkey = -1
       do i = 1, nh(seat)
          cd = hands(i, seat)
          if (.not. is_point(cd)) then
             key = (rank_of(cd) - 1) * 4 + suit_of(cd)
             if (key > bkey) then
                bkey = key
                c = cd
             end if
          end if
       end do
       if (c >= 0) return
       if (find_in_hand(seat, CARD_QS) > 0) then
          c = CARD_QS
          return
       end if
       c = hands(nh(seat), seat)           ! all hearts: highest
       return
    end if
    if (find_in_hand(seat, CARD_QS) > 0) then
       c = CARD_QS
       return
    end if
    if (suit_of(hands(nh(seat), seat)) == 4) then
       c = hands(nh(seat), seat)           ! sorted: last card = highest heart
       return
    end if
    bkey = -1
    do i = 1, nh(seat)
       cd = hands(i, seat)
       key = (rank_of(cd) - 1) * 4 + suit_of(cd)
       if (key > bkey) then
          bkey = key
          c = cd
       end if
    end do
  end function choose_card

  ! ---- status --------------------------------------------------------------

  logical function south_wins() result(w)
    w = (scores(1) < scores(2) .and. scores(1) < scores(3) .and. &
         scores(1) < scores(4))
  end function south_wins

  ! Lowest total wins; SOUTH only on a strict low, ties go to the machine
  ! (first of WEST, NORTH, EAST at the minimum).
  integer function winner_seat() result(wseat)
    integer :: s, mn
    mn = scores(1)
    do s = 2, 4
       if (scores(s) < mn) mn = scores(s)
    end do
    if (south_wins()) then
       wseat = 1
       return
    end if
    wseat = 0
    do s = 2, 4
       if (wseat == 0 .and. scores(s) == mn) wseat = s
    end do
    if (wseat == 0) wseat = 1
  end function winner_seat

  ! ---- display --------------------------------------------------------------

  subroutine add_disp(s)
    character(len=*), intent(in) :: s
    if (ndisp >= MAXD) return
    ndisp = ndisp + 1
    disp(ndisp) = s
  end subroutine add_disp

  ! Display-only seat label: seat 1 reads "SOUTH (YOU)" so the human can spot
  ! their own seat. STATE serialization and parsing keep the bare SEAT_NAME —
  ! this suffix is added at render time only, never in the state block.
  character(len=11) function seat_disp(seat) result(s)
    integer, intent(in) :: seat
    if (seat == 1) then
       s = 'SOUTH (YOU)'
    else
       s = SEAT_NAME(seat)
    end if
  end function seat_disp

  ! Present the position now facing SOUTH: a blank separator, the lead header,
  ! the cards played to the trick so far (if any), then the hand and prompt.
  ! The blank line precedes every "[<seat> LEADS]" so tricks read as blocks.
  subroutine present_position()
    call add_disp('')
    call add_disp('['//trim(seat_disp(lead))//' LEADS]')
    if (ntr > 0) call add_disp(trim(trick_line()))
    call add_prompt()
  end subroutine present_position

  subroutine add_prompt()
    call add_disp('HAND: '//trim(card_field(hands(:, 1), nh(1))))
    if (ntr == 0) then
       call add_disp('YOUR LEAD?')
    else
       call add_disp('YOUR PLAY?')
    end if
  end subroutine add_prompt

  ! Cards played to the current trick so far, in play order (leader first),
  ! comma-separated: "WEST: 2C, NORTH: 3C, EAST: 7C". SOUTH reads "SOUTH (YOU)".
  ! Used for both the in-progress position and the completed-trick recap.
  character(len=60) function trick_line() result(s)
    integer :: k, seat
    s = ''
    do k = 1, ntr
       seat = seat_at(k - 1)
       if (k == 1) then
          s = trim(seat_disp(seat))//': '//card_str(trick(k))
       else
          s = trim(s)//', '//trim(seat_disp(seat))//': '//card_str(trick(k))
       end if
    end do
  end function trick_line

  character(len=60) function tally(v) result(s)
    integer, intent(in) :: v(4)
    s = trim(seat_disp(1))//' '//trim(itoa(v(1)))//'  WEST '//trim(itoa(v(2)))// &
        '  NORTH '//trim(itoa(v(3)))//'  EAST '//trim(itoa(v(4)))
  end function tally

  character(len=24) function four(v) result(s)
    integer, intent(in) :: v(4)
    s = trim(itoa(v(1)))//' '//trim(itoa(v(2)))//' '// &
        trim(itoa(v(3)))//' '//trim(itoa(v(4)))
  end function four

  character(len=40) function card_field(arr, n) result(s)
    integer, intent(in) :: arr(*), n
    integer :: i
    if (n == 0) then
       s = '-'
    else
       s = card_str(arr(1))
       do i = 2, n
          s = trim(s)//' '//card_str(arr(i))
       end do
    end if
  end function card_field

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

end program hearts
