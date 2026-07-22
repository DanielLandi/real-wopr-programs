!===============================================================================
! WOPR game — GIN RUMMY (heads-up standard gin rummy vs W.O.P.R.)
!
! Self-contained WOPR/1 program (docs/games.md): reads one request frame from
! stdin, writes one response frame to stdout, exits. No network, no DB, no
! state between calls. Deterministic: same state + input => same output.
!
! Rules (standard gin rummy, documented simplifications):
!   - 10 cards each, one upcard starts the discard pile. The initial
!     upcard-offer ritual is omitted: the player simply moves first each hand.
!   - A turn is DRAW (stock) or TAKE (discard-pile top), then DISCARD <card>
!     or KNOCK <card> (discard + knock). The card just taken from the pile
!     may not be discarded the same turn (standard rule, enforced).
!   - KNOCK is legal when the deadwood of the remaining 10 cards is 10 or
!     less. Going gin = 0 deadwood.
!   - Scoring: knock = deadwood difference to the knocker; undercut
!     (defender deadwood <= knocker's, after layoffs) = difference + 25 to
!     the defender; gin = defender deadwood + 25, layoffs not allowed.
!   - Layoffs are automatic: the defender's deadwood cards that extend the
!     knocker's melds are laid off iteratively (a layoff can enable another).
!     Approximation: the defender melds its own hand for minimum deadwood
!     first, then lays off greedily — it does not re-meld to maximize layoffs.
!   - The hand is void (no score) when the stock is down to 2 cards at the
!     moment a side would begin its turn — even though a pile TAKE would
!     still be physically possible (documented simplification).
!   - Match to 100. No line/box/game bonuses (documented simplification).
!     STATUS is from the player's perspective; RESULT names the winner.
!   - Aces are low (A-2-3 is a run, Q-K-A is not). A=1, face cards=10.
!
! Meld engine: optimal deadwood via exhaustive search — enumerate every
! candidate set (3-4 of a kind) and run (3+ consecutive, same suit) in the
! 10-11 card hand, then depth-first search over disjoint combinations for
! the minimum-deadwood partition. Ties keep the first partition found in
! enumeration order (sets by rank, then runs by suit and start): explicit
! and deterministic.
!
! W.O.P.R. doctrine (deterministic, own hand + pile top only):
!   - Takes the discard only if it immediately forms or extends a meld with
!     cards already held (a pair of its rank, or two same-suit neighbors);
!     otherwise draws from the stock.
!   - Knocks as soon as legal: picks the discard minimizing deadwood of the
!     kept 10 (first such card in ascending hand order on ties).
!   - Otherwise discards the highest-value deadwood card of its optimal
!     11-card partition (ties: highest rank, then suit order C<D<H<S, the
!     highest taken). Never discards the card it just took from the pile.
!
! In-game rule violations (illegal knock, card not held, wrong phase for a
! valid verb) refuse in-game: STATUS PLAYING plus an explanatory line, state
! unchanged. Only malformed/protocol errors produce an ERROR frame and a
! non-zero exit (docs/games.md §2.3).
!
! Determinism: the deck is shuffled by a Park-Miller MINSTD LCG (Schrage's
! method) seeded from the HAND number + both match scores at DEAL time —
! never the wall clock. The undealt stock and the discard pile ride in the
! STATE block so every draw is reproducible.
!
! State block (8 lines, opaque outside this game):
!   HAND <n> / SCORE <player> <wopr> / PHASE <IDLE|DRAW|DISCARD> /
!   TOOK <card|-> / PHAND <cards|-> / WHAND <cards|-> /
!   PILE <k> [cards, top first] / DECK <k> [cards, next draw first]
! Cards are <rank><suit>, ranks A23456789TJQK (T = ten), suits CDHS.
!
! Commands:
!   NEW    — fresh match, 0-0, awaiting DEAL (STATE 0 in request).
!   MOVE   — requires INPUT: DEAL | DRAW | TAKE | DISCARD <card> |
!            KNOCK <card>   (players=1: W.O.P.R. answers within the same
!            frame; INPUT omitted = error).
!   QUERY  — re-emit state + situation display without mutating anything.
!
! Period constraints (docs/games.md §7): F90 constructs only (RECURSIVE for
! the partition search), no libraries, no wall clock. Memory budget in the
! manifest.
!===============================================================================
program ginrummy
  implicit none

  character(len=*), parameter :: GAME_ID = 'gin-rummy'
  character(len=*), parameter :: RANKS = 'A23456789TJQK'
  character(len=*), parameter :: SUITS = 'CDHS'
  integer, parameter :: MATCH_GOAL = 100
  integer, parameter :: KNOCK_MAX = 10
  integer, parameter :: BONUS = 25
  character(len=*), parameter :: DISC_PROMPT = &
       'DISCARD <CARD> OR KNOCK <CARD>?'

  integer :: hand_no, pscore, wscore
  character(len=8) :: phase
  character(len=2) :: took
  character(len=2) :: phand(11), whand(11), pile(52), deck(52)
  integer :: nph, nwh, npile, ndeck

  ! meld solver working set (host-associated; hands are at most 11 cards)
  integer :: sv_n, sv_total
  integer :: sv_r(11), sv_s(11), sv_v(11)
  integer :: sv_nc, sv_mask(64), sv_mval(64)
  integer :: sv_best, sv_bestn, sv_bestsel(4), sv_cursel(4)

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
  pscore = 0
  wscore = 0
  phase = 'IDLE'
  took = '- '
  nph = 0
  nwh = 0
  npile = 0
  ndeck = 0
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
     if (nstate /= 8) call die('BAD STATE BLOCK')
     do i = 1, 8
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
  if (trim(phase) == 'IDLE' .and. pscore >= MATCH_GOAL) then
     st = 'WIN'
  else if (trim(phase) == 'IDLE' .and. wscore >= MATCH_GOAL) then
     st = 'LOSS'
  else
     st = 'PLAYING'
  end if

  ! ---- response frame ----------------------------------------------------------------
  write(*,'(A)') 'WOPR/1 '//GAME_ID//' OK'
  write(*,'(A)') 'STATE 8'
  write(*,'(A)') 'HAND '//trim(itoa(hand_no))
  write(*,'(A)') 'SCORE '//trim(itoa(pscore))//' '//trim(itoa(wscore))
  write(*,'(A)') 'PHASE '//trim(phase)
  write(*,'(A)') 'TOOK '//trim(took)
  write(*,'(A)') 'PHAND '//trim(cards_str(phand, nph))
  write(*,'(A)') 'WHAND '//trim(cards_str(whand, nwh))
  buf = 'PILE '//trim(itoa(npile))
  do i = 1, npile
     buf = trim(buf)//' '//pile(i)
  end do
  write(*,'(A)') trim(buf)
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

  ! -- frame plumbing ----------------------------------------------------------

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
       if (len_trim(l) < 7 .or. l(1:6) /= 'SCORE ') call die('BAD STATE')
       read(l(7:), *, iostat=ios) pscore, wscore
       if (ios /= 0 .or. pscore < 0 .or. wscore < 0) call die('BAD STATE')
    case (3)
       if (len_trim(l) < 7 .or. l(1:6) /= 'PHASE ') call die('BAD STATE')
       phase = adjustl(l(7:))
       if (trim(phase) /= 'IDLE' .and. trim(phase) /= 'DRAW' .and. &
           trim(phase) /= 'DISCARD') call die('BAD STATE')
    case (4)
       if (len_trim(l) < 6 .or. l(1:5) /= 'TOOK ') call die('BAD STATE')
       buf = adjustl(l(6:))
       if (trim(buf) == '-') then
          took = '- '
       else
          if (.not. valid_card(buf(1:2)) .or. len_trim(buf) /= 2) &
               call die('BAD STATE')
          took = buf(1:2)
       end if
    case (5)
       if (len_trim(l) < 7 .or. l(1:6) /= 'PHAND ') call die('BAD STATE')
       call parse_cardlist(l(7:), phand, nph, 11)
    case (6)
       if (len_trim(l) < 7 .or. l(1:6) /= 'WHAND ') call die('BAD STATE')
       call parse_cardlist(l(7:), whand, nwh, 11)
    case (7)
       call parse_stack(l, 'PILE ', pile, npile, 32)
    case (8)
       call parse_stack(l, 'DECK ', deck, ndeck, 31)
    end select
  end subroutine parse_state_line

  subroutine parse_cardlist(rest, h, n, maxn)
    character(len=*), intent(in)  :: rest
    character(len=2), intent(out) :: h(11)
    integer, intent(out) :: n
    integer, intent(in)  :: maxn
    character(len=64) :: tok
    logical :: found
    integer :: pos
    n = 0
    h = '- '
    if (trim(adjustl(rest)) == '-') return
    pos = 1
    do
       call next_tok(rest, pos, tok, found)
       if (.not. found) exit
       if (.not. valid_card(tok)) call die('BAD STATE')
       if (n >= maxn) call die('BAD STATE')
       n = n + 1
       h(n) = tok(1:2)
    end do
    if (n == 0) call die('BAD STATE')
  end subroutine parse_cardlist

  subroutine parse_stack(l, prefix, arr, n, maxn)
    character(len=*), intent(in)  :: l, prefix
    character(len=2), intent(out) :: arr(52)
    integer, intent(out) :: n
    integer, intent(in)  :: maxn
    character(len=64) :: tok
    logical :: found
    integer :: pos, k, ios, lp
    lp = len(prefix)
    if (len_trim(l) < lp + 1 .or. l(1:lp) /= prefix) call die('BAD STATE')
    pos = lp + 1
    call next_tok(l, pos, tok, found)
    if (.not. found) call die('BAD STATE')
    read(tok, *, iostat=ios) n
    if (ios /= 0 .or. n < 0 .or. n > maxn) call die('BAD STATE')
    do k = 1, n
       call next_tok(l, pos, tok, found)
       if (.not. found) call die('BAD STATE')
       if (.not. valid_card(tok)) call die('BAD STATE')
       arr(k) = tok(1:2)
    end do
    call next_tok(l, pos, tok, found)
    if (found) call die('BAD STATE')
  end subroutine parse_stack

  subroutine check_state()
    select case (trim(phase))
    case ('IDLE')
       if (nph /= 0 .or. nwh /= 0) call die('BAD STATE')
       if (npile /= 0 .or. ndeck /= 0) call die('BAD STATE')
       if (trim(took) /= '-') call die('BAD STATE')
    case ('DRAW')
       if (nph /= 10 .or. nwh /= 10) call die('BAD STATE')
       if (npile < 1) call die('BAD STATE')
       if (trim(took) /= '-') call die('BAD STATE')
    case ('DISCARD')
       if (nph /= 11 .or. nwh /= 10) call die('BAD STATE')
    end select
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
    character(len=64) :: w1, ctok
    integer :: sp, idx
    if (trim(phase) == 'IDLE' .and. &
        (pscore >= MATCH_GOAL .or. wscore >= MATCH_GOAL)) then
       call die('GAME ALREADY OVER')
    end if
    sp = index(trim(m), ' ')
    if (sp == 0) then
       w1 = m
       ctok = ''
    else
       w1 = m(1:sp-1)
       ctok = adjustl(m(sp+1:))
    end if
    select case (trim(phase))
    case ('IDLE')
       if (trim(m) == 'DEAL') then
          call deal()
       else if (trim(w1) == 'DRAW' .or. trim(w1) == 'TAKE' .or. &
                trim(w1) == 'DISCARD' .or. trim(w1) == 'KNOCK') then
          call add('NO HAND IN PLAY. TYPE DEAL FOR HAND '// &
                   trim(itoa(hand_no))//'.')
       else
          call die('INVALID COMMAND')
       end if
    case ('DRAW')
       if (trim(m) == 'DRAW') then
          call draw_stock()
       else if (trim(m) == 'TAKE') then
          call take_pile()
       else if (trim(w1) == 'DEAL') then
          call add('A HAND IS ALREADY IN PLAY.')
          call add('STOCK '//trim(itoa(ndeck))//'. DRAW OR TAKE '// &
                   pile(1)//'?')
       else if (trim(w1) == 'DISCARD' .or. trim(w1) == 'KNOCK') then
          call add('DRAW OR TAKE FIRST.')
          call add('STOCK '//trim(itoa(ndeck))//'. DRAW OR TAKE '// &
                   pile(1)//'?')
       else
          call die('INVALID COMMAND')
       end if
    case ('DISCARD')
       if (trim(w1) == 'DISCARD' .or. trim(w1) == 'KNOCK') then
          if (len_trim(ctok) /= 2) call die('INVALID CARD')
          if (.not. valid_card(ctok)) call die('INVALID CARD')
          idx = find_card(phand, nph, ctok(1:2))
          if (idx == 0) then
             call add('YOU DO NOT HOLD '//ctok(1:2)//'.')
             call add(DISC_PROMPT)
          else if (trim(took) /= '-' .and. ctok(1:2) == took) then
             call add('CANNOT DISCARD THE CARD YOU TOOK.')
             call add(DISC_PROMPT)
          else
             call player_discard(idx, trim(w1) == 'KNOCK')
          end if
       else if (trim(w1) == 'DRAW' .or. trim(w1) == 'TAKE') then
          call add('YOU MUST DISCARD OR KNOCK.')
          call add(DISC_PROMPT)
       else if (trim(w1) == 'DEAL') then
          call add('A HAND IS ALREADY IN PLAY.')
          call add(DISC_PROMPT)
       else
          call die('INVALID COMMAND')
       end if
    end select
  end subroutine do_move

  subroutine deal()
    integer :: s, i2, j
    character(len=2) :: tmp
    ! Seed from state only (hand number + match scores): deterministic.
    s = mod(mod(hand_no, 65521) * 7919 + pscore * 104729 + wscore * 224737, &
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
    do i2 = 1, 10
       phand(i2) = deck(i2)
       whand(i2) = deck(i2 + 10)
    end do
    nph = 10
    nwh = 10
    pile(1) = deck(21)
    npile = 1
    do i2 = 1, 31
       deck(i2) = deck(i2 + 21)
    end do
    ndeck = 31
    call sort_asc(phand, nph)
    call sort_asc(whand, nwh)
    phase = 'DRAW'
    took = '- '
    call add('HAND '//trim(itoa(hand_no))//'. YOUR CARDS:')
    call add(cards_str(phand, nph))
    call add('UPCARD '//pile(1)//'. STOCK 31.')
    call add('DRAW OR TAKE '//pile(1)//'?')
  end subroutine deal

  subroutine draw_stock()
    character(len=2) :: c
    if (ndeck <= 2) call die('BAD STATE')
    c = pop_front(deck, ndeck)
    nph = nph + 1
    phand(nph) = c
    call sort_asc(phand, nph)
    phase = 'DISCARD'
    took = '- '
    call add('YOU DRAW '//c//'. YOUR CARDS:')
    call add(cards_str(phand, nph))
    call add(DISC_PROMPT)
  end subroutine draw_stock

  subroutine take_pile()
    character(len=2) :: c
    c = pop_front(pile, npile)
    nph = nph + 1
    phand(nph) = c
    call sort_asc(phand, nph)
    phase = 'DISCARD'
    took = c
    call add('YOU TAKE '//c//'. YOUR CARDS:')
    call add(cards_str(phand, nph))
    call add(DISC_PROMPT)
  end subroutine take_pile

  subroutine player_discard(idx, knocking)
    integer, intent(in) :: idx
    logical, intent(in) :: knocking
    character(len=2) :: c, keep(11)
    integer :: dwv, k, kk
    integer :: nm, mt(4), mr(4), msu(4), mlo(4), mhi(4), msz(4)
    logical :: indead(11)
    if (knocking) then
       kk = 0
       do k = 1, nph
          if (k /= idx) then
             kk = kk + 1
             keep(kk) = phand(k)
          end if
       end do
       call solve(keep, 10, dwv, nm, mt, mr, msu, mlo, mhi, msz, indead)
       if (dwv > KNOCK_MAX) then
          call add('CANNOT KNOCK - DEADWOOD '//trim(itoa(dwv))// &
                   ' EXCEEDS 10.')
          call add(DISC_PROMPT)
          return
       end if
    end if
    c = phand(idx)
    call remove_at(phand, nph, idx)
    call push_front(pile, npile, c)
    took = '- '
    if (knocking) then
       if (dwv == 0) then
          call add('YOU DISCARD '//c//' AND KNOCK. GIN.')
       else
          call add('YOU DISCARD '//c//' AND KNOCK WITH '// &
                   trim(itoa(dwv))//'.')
       end if
       call resolve_knock(1, dwv)
    else
       call add('YOU DISCARD '//c//'.')
       call wopr_turn()
    end if
  end subroutine player_discard

  ! W.O.P.R.'s full turn, played after the player's plain discard.
  subroutine wopr_turn()
    character(len=2) :: c, wtook, keep(11)
    integer :: bestdw, besti, dwv, i2, k, kk, bestkey, key
    integer :: nm, mt(4), mr(4), msu(4), mlo(4), mhi(4), msz(4)
    logical :: indead(11)
    if (ndeck == 2) then
       call void_hand()
       return
    end if
    wtook = '- '
    if (take_makes_meld(pile(1))) then
       wtook = pop_front(pile, npile)
       nwh = nwh + 1
       whand(nwh) = wtook
       call add('WOPR TAKES '//wtook//'.')
    else
       nwh = nwh + 1
       whand(nwh) = pop_front(deck, ndeck)
       call add('WOPR DRAWS FROM STOCK.')
    end if
    call sort_asc(whand, nwh)
    ! Knock as soon as legal: minimize kept deadwood over legal discards.
    bestdw = 999
    besti = 0
    do i2 = 1, nwh
       if (trim(wtook) /= '-' .and. whand(i2) == wtook) cycle
       kk = 0
       do k = 1, nwh
          if (k /= i2) then
             kk = kk + 1
             keep(kk) = whand(k)
          end if
       end do
       call solve(keep, 10, dwv, nm, mt, mr, msu, mlo, mhi, msz, indead)
       if (dwv < bestdw) then
          bestdw = dwv
          besti = i2
       end if
    end do
    if (bestdw <= KNOCK_MAX) then
       c = whand(besti)
       call remove_at(whand, nwh, besti)
       call push_front(pile, npile, c)
       if (bestdw == 0) then
          call add('WOPR DISCARDS '//c//' AND KNOCKS. GIN.')
       else
          call add('WOPR DISCARDS '//c//' AND KNOCKS WITH '// &
                   trim(itoa(bestdw))//'.')
       end if
       call resolve_knock(2, bestdw)
       return
    end if
    ! No knock: shed the highest-value deadwood card (never the taken one).
    call solve(whand, nwh, dwv, nm, mt, mr, msu, mlo, mhi, msz, indead)
    besti = 0
    bestkey = -1
    do i2 = 1, nwh
       if (trim(wtook) /= '-' .and. whand(i2) == wtook) cycle
       if (.not. indead(i2)) cycle
       key = card_val(whand(i2)) * 1000 + rank_of(whand(i2)) * 10 + &
             suit_of(whand(i2))
       if (key > bestkey) then
          bestkey = key
          besti = i2
       end if
    end do
    if (besti == 0) then
       ! Everything but the taken card is melded: break the cheapest meld.
       do i2 = 1, nwh
          if (trim(wtook) /= '-' .and. whand(i2) == wtook) cycle
          key = card_val(whand(i2)) * 1000 + rank_of(whand(i2)) * 10 + &
                suit_of(whand(i2))
          if (key > bestkey) then
             bestkey = key
             besti = i2
          end if
       end do
    end if
    c = whand(besti)
    call remove_at(whand, nwh, besti)
    call push_front(pile, npile, c)
    call add('WOPR DISCARDS '//c//'.')
    if (ndeck == 2) then
       call void_hand()
       return
    end if
    phase = 'DRAW'
    took = '- '
    call add('YOUR CARDS:')
    call add(cards_str(phand, nph))
    call add('STOCK '//trim(itoa(ndeck))//'. DRAW OR TAKE '//pile(1)//'?')
  end subroutine wopr_turn

  ! Doctrine: take the pile top only if it immediately forms/extends a meld —
  ! a pair of its rank in hand, or two same-suit neighbors completing a run.
  logical function take_makes_meld(c) result(yes)
    character(len=2), intent(in) :: c
    integer :: r, s, i2, cnt
    logical :: has(0:14)
    r = rank_of(c)
    s = suit_of(c)
    cnt = 0
    has = .false.
    do i2 = 1, nwh
       if (rank_of(whand(i2)) == r) cnt = cnt + 1
       if (suit_of(whand(i2)) == s) has(rank_of(whand(i2))) = .true.
    end do
    yes = .false.
    if (cnt >= 2) yes = .true.
    if (r >= 3) then
       if (has(r-2) .and. has(r-1)) yes = .true.
    end if
    if (r >= 2 .and. r <= 12) then
       if (has(r-1) .and. has(r+1)) yes = .true.
    end if
    if (r <= 11) then
       if (has(r+1) .and. has(r+2)) yes = .true.
    end if
  end function take_makes_meld

  ! Score a knock. who = 1 (player knocked) or 2 (W.O.P.R. knocked).
  subroutine resolve_knock(who, kdw)
    integer, intent(in) :: who, kdw
    integer :: knm, kmt(4), kmr(4), kmsu(4), kmlo(4), kmhi(4), kmsz(4)
    integer :: dnm, dmt(4), dmr(4), dmsu(4), dmlo(4), dmhi(4), dmsz(4)
    integer :: kdw2, ddw0, ddw, laidsum, pts, pdw, wdw
    logical :: kdead(11), ddead(11), laid(11)
    character(len=2) :: kh(11), dh(11)
    integer :: i2, nlaid
    if (who == 1) then
       kh(1:10) = phand(1:10)
       dh(1:10) = whand(1:10)
    else
       kh(1:10) = whand(1:10)
       dh(1:10) = phand(1:10)
    end if
    call solve(kh, 10, kdw2, knm, kmt, kmr, kmsu, kmlo, kmhi, kmsz, kdead)
    call solve(dh, 10, ddw0, dnm, dmt, dmr, dmsu, dmlo, dmhi, dmsz, ddead)
    laid = .false.
    laidsum = 0
    if (kdw > 0) then
       call apply_layoffs(dh, 10, ddead, knm, kmt, kmr, kmsu, kmlo, kmhi, &
                          kmsz, laid, laidsum)
    end if
    ddw = ddw0 - laidsum
    call add('WOPR SHOWS '//cards_str(whand, 10))
    nlaid = 0
    do i2 = 1, 10
       if (laid(i2)) nlaid = nlaid + 1
    end do
    if (nlaid > 0) then
       buf = ''
       do i2 = 1, 10
          if (laid(i2)) buf = trim(buf)//' '//dh(i2)
       end do
       if (who == 1) then
          call add('WOPR LAYS OFF'//trim(buf)//'.')
       else
          call add('YOU LAY OFF'//trim(buf)//'.')
       end if
    end if
    if (who == 1) then
       pdw = kdw
       wdw = ddw
    else
       pdw = ddw
       wdw = kdw
    end if
    call add('YOUR DEADWOOD '//trim(itoa(pdw))//'. WOPR DEADWOOD '// &
             trim(itoa(wdw))//'.')
    if (kdw == 0) then
       pts = ddw + BONUS
       if (who == 1) then
          pscore = pscore + pts
          call add('YOU SCORE '//trim(itoa(pts))//'. GIN BONUS 25.')
       else
          wscore = wscore + pts
          call add('WOPR SCORES '//trim(itoa(pts))//'. GIN BONUS 25.')
       end if
    else if (ddw <= kdw) then
       pts = (kdw - ddw) + BONUS
       if (who == 1) then
          wscore = wscore + pts
          call add('WOPR SCORES '//trim(itoa(pts))//'. UNDERCUT.')
       else
          pscore = pscore + pts
          call add('YOU SCORE '//trim(itoa(pts))//'. UNDERCUT.')
       end if
    else
       pts = ddw - kdw
       if (who == 1) then
          pscore = pscore + pts
          call add('YOU SCORE '//trim(itoa(pts))//'.')
       else
          wscore = wscore + pts
          call add('WOPR SCORES '//trim(itoa(pts))//'.')
       end if
    end if
    call finish_hand()
  end subroutine resolve_knock

  subroutine void_hand()
    call add('STOCK EXHAUSTED. HAND VOID. NO SCORE.')
    call finish_hand()
  end subroutine void_hand

  subroutine finish_hand()
    phase = 'IDLE'
    took = '- '
    nph = 0
    nwh = 0
    npile = 0
    ndeck = 0
    phand = '- '
    whand = '- '
    hand_no = hand_no + 1
    call add('SCORE  YOU '//trim(itoa(pscore))//'  WOPR '// &
             trim(itoa(wscore))//'.')
    if (pscore >= MATCH_GOAL) then
       call add('YOU REACH 100. YOU WIN THE MATCH.')
    else if (wscore >= MATCH_GOAL) then
       call add('WOPR REACHES 100. WOPR WINS THE MATCH.')
    else
       call add('TYPE DEAL FOR HAND '//trim(itoa(hand_no))//'.')
    end if
  end subroutine finish_hand

  ! -- displays ----------------------------------------------------------------

  subroutine show_new()
    call add('GIN RUMMY. FIRST TO 100 WINS THE MATCH.')
    call add('KNOCK AT 10 OR LESS. GIN AND UNDERCUT PAY 25.')
    call add('TYPE DEAL FOR HAND 1.')
  end subroutine show_new

  subroutine show_query()
    select case (trim(phase))
    case ('IDLE')
       call add('SCORE  YOU '//trim(itoa(pscore))//'  WOPR '// &
                trim(itoa(wscore))//'.')
       if (pscore >= MATCH_GOAL) then
          call add('YOU WIN THE MATCH.')
       else if (wscore >= MATCH_GOAL) then
          call add('WOPR WINS THE MATCH.')
       else
          call add('TYPE DEAL FOR HAND '//trim(itoa(hand_no))//'.')
       end if
    case ('DRAW')
       call add('YOUR CARDS:')
       call add(cards_str(phand, nph))
       call add('STOCK '//trim(itoa(ndeck))//'. DRAW OR TAKE '//pile(1)//'?')
    case ('DISCARD')
       call add('YOUR CARDS:')
       call add(cards_str(phand, nph))
       call add(DISC_PROMPT)
    end select
  end subroutine show_query

  ! -- meld solver ---------------------------------------------------------------
  !
  ! Optimal deadwood by exhaustive search: enumerate every candidate set and
  ! run in the hand, then DFS over disjoint combinations. Hands are at most
  ! 11 cards, so the space is tiny. First minimal partition (in enumeration
  ! order) is kept: deterministic tie-break.

  subroutine solve(h, n, dw, nm, mt, mr, msu, mlo, mhi, msz, indead)
    character(len=2), intent(in) :: h(11)
    integer, intent(in)  :: n
    integer, intent(out) :: dw, nm
    integer, intent(out) :: mt(4), mr(4), msu(4), mlo(4), mhi(4), msz(4)
    logical, intent(out) :: indead(11)
    integer :: j, k, msk, cnt, rmin, rmax
    logical :: isset
    call sv_build(h, n)
    sv_best = sv_total
    sv_bestn = 0
    call sv_dfs(1, 0, 0, 0)
    dw = sv_best
    nm = sv_bestn
    indead = .true.
    do j = 1, nm
       msk = sv_mask(sv_bestsel(j))
       cnt = 0
       rmin = 99
       rmax = 0
       isset = .true.
       do k = 1, n
          if (btest(msk, k-1)) then
             indead(k) = .false.
             cnt = cnt + 1
             if (sv_r(k) < rmin) rmin = sv_r(k)
             if (sv_r(k) > rmax) rmax = sv_r(k)
             msu(j) = sv_s(k)
             mr(j) = sv_r(k)
          end if
       end do
       if (rmin /= rmax) isset = .false.
       if (isset) then
          mt(j) = 1
       else
          mt(j) = 2
       end if
       mlo(j) = rmin
       mhi(j) = rmax
       msz(j) = cnt
    end do
  end subroutine solve

  subroutine sv_build(h, n)
    character(len=2), intent(in) :: h(11)
    integer, intent(in) :: n
    integer :: i2, rr, ss, cnt, idx(4), drop, k, msk, val
    integer :: pos(13), hi
    sv_n = n
    sv_total = 0
    do i2 = 1, n
       sv_r(i2) = rank_of(h(i2))
       sv_s(i2) = suit_of(h(i2))
       sv_v(i2) = card_val(h(i2))
       sv_total = sv_total + sv_v(i2)
    end do
    sv_nc = 0
    ! sets: 3-subsets and the 4-set of each rank
    do rr = 1, 13
       cnt = 0
       do i2 = 1, n
          if (sv_r(i2) == rr) then
             cnt = cnt + 1
             if (cnt <= 4) idx(cnt) = i2
          end if
       end do
       if (cnt == 3) then
          msk = 0
          do k = 1, 3
             msk = ibset(msk, idx(k)-1)
          end do
          call sv_add(msk, 3 * min(rr, 10))
       else if (cnt == 4) then
          do drop = 1, 4
             msk = 0
             do k = 1, 4
                if (k /= drop) msk = ibset(msk, idx(k)-1)
             end do
             call sv_add(msk, 3 * min(rr, 10))
          end do
          msk = 0
          do k = 1, 4
             msk = ibset(msk, idx(k)-1)
          end do
          call sv_add(msk, 4 * min(rr, 10))
       end if
    end do
    ! runs: every same-suit interval of length >= 3
    do ss = 1, 4
       pos = 0
       do i2 = 1, n
          if (sv_s(i2) == ss) pos(sv_r(i2)) = i2
       end do
       do rr = 1, 11
          if (pos(rr) == 0) cycle
          msk = ibset(0, pos(rr)-1)
          val = min(rr, 10)
          do hi = rr + 1, 13
             if (pos(hi) == 0) exit
             msk = ibset(msk, pos(hi)-1)
             val = val + min(hi, 10)
             if (hi - rr >= 2) call sv_add(msk, val)
          end do
       end do
    end do
  end subroutine sv_build

  subroutine sv_add(msk, val)
    integer, intent(in) :: msk, val
    if (sv_nc >= 64) call die('MELD TABLE OVERFLOW')
    sv_nc = sv_nc + 1
    sv_mask(sv_nc) = msk
    sv_mval(sv_nc) = val
  end subroutine sv_add

  recursive subroutine sv_dfs(k, used, mval, ncur)
    integer, intent(in) :: k, used, mval, ncur
    integer :: kk
    if (sv_total - mval < sv_best) then
       sv_best = sv_total - mval
       sv_bestn = ncur
       sv_bestsel(1:ncur) = sv_cursel(1:ncur)
    end if
    do kk = k, sv_nc
       if (iand(used, sv_mask(kk)) == 0) then
          sv_cursel(ncur+1) = kk
          call sv_dfs(kk+1, ior(used, sv_mask(kk)), mval + sv_mval(kk), &
                      ncur+1)
       end if
    end do
  end subroutine sv_dfs

  ! Iterative layoffs: defender deadwood cards that extend the knocker's
  ! melds are laid off; repeat sweeps until nothing changes (a laid-off run
  ! extension can enable the next card).
  subroutine apply_layoffs(dh, n, indead, nm, mt, mr, msu, mlo, mhi, msz, &
                           laid, laidsum)
    character(len=2), intent(in) :: dh(11)
    integer, intent(in) :: n, nm
    logical, intent(in) :: indead(11)
    integer, intent(inout) :: mt(4), mr(4), msu(4), mlo(4), mhi(4), msz(4)
    logical, intent(out) :: laid(11)
    integer, intent(out) :: laidsum
    integer :: i2, m, r, s
    logical :: changed
    laid = .false.
    laidsum = 0
    changed = .true.
    do while (changed)
       changed = .false.
       do i2 = 1, n
          if (.not. indead(i2)) cycle
          if (laid(i2)) cycle
          r = rank_of(dh(i2))
          s = suit_of(dh(i2))
          do m = 1, nm
             if (mt(m) == 1) then
                if (r == mr(m) .and. msz(m) < 4) then
                   msz(m) = msz(m) + 1
                   laid(i2) = .true.
                   laidsum = laidsum + card_val(dh(i2))
                   changed = .true.
                   exit
                end if
             else
                if (s == msu(m)) then
                   if (r == mlo(m) - 1) then
                      mlo(m) = r
                      laid(i2) = .true.
                      laidsum = laidsum + card_val(dh(i2))
                      changed = .true.
                      exit
                   else if (r == mhi(m) + 1) then
                      mhi(m) = r
                      laid(i2) = .true.
                      laidsum = laidsum + card_val(dh(i2))
                      changed = .true.
                      exit
                   end if
                end if
             end if
          end do
       end do
    end do
  end subroutine apply_layoffs

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
    r = (i2 - 1) / 4 + 1
    u = mod(i2 - 1, 4) + 1
    c = RANKS(r:r)//SUITS(u:u)
  end function card_code

  integer function rank_of(c) result(r)
    character(len=2), intent(in) :: c
    r = index(RANKS, c(1:1))
  end function rank_of

  integer function suit_of(c) result(u)
    character(len=2), intent(in) :: c
    u = index(SUITS, c(2:2))
  end function suit_of

  integer function card_val(c) result(v)
    character(len=2), intent(in) :: c
    v = min(rank_of(c), 10)
  end function card_val

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

  ! Insertion sort, ascending by rank (A low) then suit C<D<H<S: deterministic.
  subroutine sort_asc(h, n)
    character(len=2), intent(inout) :: h(11)
    integer, intent(in) :: n
    integer :: i2, j
    character(len=2) :: t
    do i2 = 2, n
       t = h(i2)
       j = i2 - 1
       do while (j >= 1)
          if (card_key(h(j)) <= card_key(t)) exit
          h(j+1) = h(j)
          j = j - 1
       end do
       h(j+1) = t
    end do
  end subroutine sort_asc

  integer function find_card(h, n, c) result(idx)
    character(len=2), intent(in) :: h(11), c
    integer, intent(in) :: n
    integer :: i2
    idx = 0
    do i2 = 1, n
       if (h(i2) == c) then
          idx = i2
          return
       end if
    end do
  end function find_card

  subroutine remove_at(h, n, idx)
    character(len=2), intent(inout) :: h(11)
    integer, intent(inout) :: n
    integer, intent(in) :: idx
    integer :: k
    do k = idx, n - 1
       h(k) = h(k + 1)
    end do
    h(n) = '- '
    n = n - 1
  end subroutine remove_at

  subroutine push_front(arr, n, c)
    character(len=2), intent(inout) :: arr(52)
    integer, intent(inout) :: n
    character(len=2), intent(in) :: c
    integer :: k
    do k = n, 1, -1
       arr(k + 1) = arr(k)
    end do
    arr(1) = c
    n = n + 1
  end subroutine push_front

  character(len=2) function pop_front(arr, n) result(c)
    character(len=2), intent(inout) :: arr(52)
    integer, intent(inout) :: n
    integer :: k
    if (n < 1) call die('BAD STATE')
    c = arr(1)
    do k = 1, n - 1
       arr(k) = arr(k + 1)
    end do
    n = n - 1
  end function pop_front

  character(len=34) function cards_str(h, n) result(s)
    character(len=2), intent(in) :: h(11)
    integer, intent(in) :: n
    integer :: i2
    if (n == 0) then
       s = '-'
       return
    end if
    s = h(1)
    do i2 = 2, n
       s = trim(s)//' '//h(i2)
    end do
  end function cards_str

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

end program ginrummy
