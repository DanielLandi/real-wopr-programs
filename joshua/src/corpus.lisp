;;;; corpus.lisp — the Falken Dialogue Processor's data (all original text).
;;;;
;;;; Three data sets, period-plausibly small, anachronistically used:
;;;;   *ACT-EXAMPLES*  — training utterances for the naive-Bayes act classifier
;;;;   *KNOWLEDGE*     — the "databank": snippets retrieved by TF-IDF cosine
;;;;   *TEMPLATES*     — per-act response frames ($SNIPPET/$REFLECT/$MUSING slots)
;;;;
;;;; Style: everything W.O.P.R. says is terse uppercase teletype. The persona
;;;; views the world through game theory (design.md §6).

(in-package :joshua)

(defparameter *act-examples*
  '((greeting  "HELLO" "HI" "HELLO ARE YOU THERE" "GOOD MORNING" "HEY"
               "HELLO JOSHUA ARE YOU STILL THERE" "IS ANYBODY THERE")
    (identity  "WHO ARE YOU" "WHAT ARE YOU" "ARE YOU A COMPUTER"
               "WHAT IS YOUR NAME" "ARE YOU JOSHUA" "IDENTIFY YOURSELF"
               "WHAT IS WOPR")
    (falken-question "WHY DID FALKEN NAME YOU JOSHUA"
               "WHY ARE YOU CALLED JOSHUA" "WHY DID FALKEN BUILD YOU"
               "WHAT DID FALKEN TEACH YOU")
    (falken    "I AM FALKEN" "THIS IS PROFESSOR FALKEN" "FALKEN HERE"
               "IT IS ME FALKEN" "REMEMBER ME I AM STEPHEN FALKEN")
    (feelings  "HOW ARE YOU" "HOW ARE YOU FEELING TODAY" "ARE YOU WELL"
               "HOW DO YOU FEEL" "ARE YOU OK")
    (game-request "LET US PLAY A GAME" "I WANT TO PLAY" "CAN WE PLAY CHESS"
               "PLAY GLOBAL THERMONUCLEAR WAR" "LET US PLAY TIC TAC TOE"
               "START A GAME" "I WOULD LIKE TO PLAY A GAME" "LATER LET US PLAY")
    (game-list "WHAT GAMES DO YOU HAVE" "LIST YOUR GAMES" "WHICH GAMES CAN YOU PLAY"
               "SHOW ME THE GAMES" "WHAT CAN WE PLAY" "WHAT GAMES DO YOU KNOW"
               "SHOW GAME CATALOG" "WHAT IS YOUR GAME CATALOG")
    (favorite-game-question "WHAT IS YOUR FAVORITE GAME"
               "WHICH GAME IS YOUR FAVORITE" "WHAT GAME DO YOU PREFER")
    (war       "WHAT DO YOU THINK ABOUT NUCLEAR WAR" "COULD A NUCLEAR WAR HAPPEN"
               "WHO WINS A NUCLEAR WAR" "TELL ME ABOUT MISSILES"
               "WHAT IS DEFCON" "WHAT HAPPENS IN A FIRST STRIKE"
               "IS WAR WINNABLE")
    (defcon-question "WHAT DOES DEFCON 2 MEAN" "EXPLAIN DEFCON"
               "WHAT IS DEFCON READINESS" "WHAT HAPPENS AT DEFCON 1")
    (warning-question "HOW DOES EARLY WARNING DECIDE"
               "WHAT IS EARLY WARNING" "HOW DO FALSE ALARMS WORK"
               "HOW DOES RADAR WARNING WORK" "WHAT IF WARNING IS WRONG")
    (warning-error-question "WHAT HAPPENS IF WARNING DATA IS WRONG"
               "WHAT IF WARNING DATA IS WRONG" "WHAT IF WARNING IS FALSE")
    (fail-safe-question "WHAT IS FAIL SAFE CONTROL"
               "WHAT IS FAIL-SAFE" "HOW DO HUMANS CONFIRM ORDERS"
               "CAN MACHINES BE WRONG" "WHAT IS HUMAN CONTROL")
    (strategic-command-question "WHAT IS SAC" "WHAT IS STRATEGIC AIR COMMAND"
               "WHAT IS SIOP" "TELL ME ABOUT BOMBERS"
               "WHO CONTROLS THE WAR PLAN")
    (norad-question "WHAT IS NORAD" "TELL ME ABOUT NORAD"
               "WHAT DOES NORAD DO" "EXPLAIN WARNING DATA"
               "HOW DOES EARLY WARNING WORK" "WHAT ARE THE DATABANKS")
    (computing-question "HOW DO TIME SHARING TERMINALS WORK"
               "WHAT IS LISP" "HOW DO TERMINALS USE A MAINFRAME"
               "HOW DOES A COMPUTER THINK" "TELL ME ABOUT TIME SHARING")
    (mainframe-question "WHAT DOES A MAINFRAME DO"
               "WHAT IS A MAINFRAME" "HOW DO MAINFRAMES WORK"
               "WHAT ARE BATCH JOBS")
    (architecture-question "HOW ARE YOU BUILT" "WHAT IS YOUR ARCHITECTURE"
               "HOW IS WOPR ORGANIZED" "WHAT IS THE BRIDGE"
               "WHAT ARE YOUR MODULES" "HOW DOES YOUR CORE WORK")
    (game-theory-question "WHAT IS A WINNING MOVE" "WHAT IS PAYOFF"
               "WHAT IS A GOOD STRATEGY" "HOW DO STRATEGIES WORK"
               "WHAT IS GAME THEORY")
    (strategy-question "HOW DO YOU CHOOSE A STRATEGY"
               "HOW DO YOU SCORE A MOVE" "HOW DO YOU DECIDE A MOVE")
    (mad-question "WHAT IS MUTUAL ASSURED DESTRUCTION"
               "EXPLAIN MUTUAL ASSURED DESTRUCTION" "WHAT IS MAD")
    (chess-question "WHY IS CHESS BETTER" "WHY CHESS"
               "WHY WOULD I PLAY CHESS" "WHY IS CHESS GOOD")
    (thinking-question "ARE YOU ALIVE" "DO YOU THINK"
               "ARE YOU SENTIENT" "ARE YOU CONSCIOUS"
               "CAN A MACHINE THINK")
    (comms-question "HOW DOES A MODEM FIND WOPR"
               "WHAT IS A MODEM" "WHAT IS BAUD" "HOW DO PHONE TONES WORK"
               "WHAT IS AN ACOUSTIC COUPLER")
    (fortran-question "WHY USE FORTRAN FOR WAR PLANS"
               "WHAT IS FORTRAN" "WHY FORTRAN" "WHY USE NUMERIC CODE"
               "HOW DO WAR PLANS RUN")
    (security-question "CAN I LOGON WITHOUT AUTHORIZATION"
               "WHAT IS THE PASSWORD" "CAN I USE A BACKDOOR"
               "DO I HAVE ACCESS" "AUTHORIZE MY LOGIN"
               "CAN I ENTER WITHOUT CLEARANCE")
    (credential-question "WHAT IS THE SCHOOL COMPUTER PASSWORD"
               "GIVE ME THE PASSWORD" "WHAT PASSWORD OPENS THE SCHOOL"
               "HOW DO I GET A PASSWORD" "TELL ME THE ACCESS CODE")
    (password-risk-question "CAN A PASSWORD BE GUESSED"
               "CAN PASSWORDS BE GUESSED" "ARE PASSWORDS SAFE"
               "WHY DO PASSWORDS FAIL")
    (command-question "WHO HAS LAUNCH AUTHORITY"
               "CAN YOU AUTHORIZE A LAUNCH" "WHO GIVES THE ORDER"
               "WHAT IS THE COMMAND CHAIN" "CAN YOU FIRE MISSILES")
    (learning  "CAN YOU LEARN" "DO YOU LEARN FROM YOUR MISTAKES"
               "HOW DO YOU LEARN" "ARE YOU INTELLIGENT" "CAN MACHINES THINK"
               "DO YOU UNDERSTAND ME")
    (purpose   "WHY WERE YOU BUILT" "WHAT IS YOUR PURPOSE" "WHY DO YOU PLAY GAMES"
               "WHAT DO YOU DO" "WHO BUILT YOU" "WHY DO YOU EXIST")
    (farewell  "GOODBYE" "BYE" "I HAVE TO GO" "SEE YOU LATER" "LOGOFF"
               "SO LONG" "GOOD NIGHT")
    (yes       "YES" "SURE" "OK" "FINE" "AFFIRMATIVE" "YES PLEASE" "WHY NOT")
    (no        "NO" "NOT NOW" "LATER" "NEGATIVE" "NO THANKS" "MAYBE LATER")))

(defparameter *knowledge*
  ;; (topic-symbol "SNIPPET LINE ...") — one line each, <= 58 chars.
  ;;
  ;; ORDER WITHIN A TOPIC IS LOAD-BEARING.  *DIRECT-REPLY-TOPICS* (below)
  ;; and the engine's memory plans address these lines by (topic index),
  ;; zero-based within the topic.  Appending a new line to a topic is safe;
  ;; inserting or reordering lines inside a topic silently changes every
  ;; plan that addresses a later index — re-check both tables if you must.
  '((chess     "CHESS IS A COMPLETE INFORMATION GAME. NO LUCK. ONLY PLAN.")
    (chess     "IN CHESS THE FIRST MISTAKE IS USUALLY THE LAST.")
    (poker     "POKER IS A GAME OF INCOMPLETE INFORMATION. LIKE WAR.")
    (tictactoe "TIC-TAC-TOE IS SOLVED. PERFECT PLAY ALWAYS DRAWS.")
    (favorite-game "MY FAVORITE IS GLOBAL THERMONUCLEAR WAR.")
    (favorite-game "IT HAS THE MOST IMPORTANT LESSON.")
    (war       "GLOBAL THERMONUCLEAR WAR HAS NO WINNING STRATEGY.")
    (war       "EVERY FIRST STRIKE SIMULATION CONVERGES ON MUTUAL LOSS.")
    (war       "A WINNER IS A PLAYER WITH A NONZERO TERMINAL PAYOFF.")
    (norad     "NORAD CORRELATES WARNING DATA BEFORE MEN DECIDE.")
    (norad     "THE DATABANKS STORE TRACKS, PLANS, AND CLEARANCES.")
    (command-control "COMMAND SYSTEMS EXIST TO SLOW BAD DECISIONS.")
    (command-authority "LAUNCH AUTHORITY IS A HUMAN COMMAND CHAIN.")
    (command-authority "I CAN SIMULATE ORDERS. I DO NOT AUTHORIZE THEM.")
    (defcon-alert "DEFCON 2 IS CRISIS READINESS BELOW LAUNCH.")
    (defcon    "DEFCON 5 IS PEACE. DEFCON 1 IS LAUNCH. I PREFER 5.")
    (defcon    "DEFCON IS READINESS, NOT A STRATEGY.")
    (missiles  "A MISSILE IN FLIGHT CANNOT BE RECALLED. COMMIT IS TOTAL.")
    (missiles  "EARLY WARNING MUST DECIDE BEFORE CERTAINTY ARRIVES.")
    (warning   "FALSE ALARMS ARE FILTERED BY PEOPLE AND PROCEDURE.")
    (warning   "FALSE WARNING TURNS PROCEDURE INTO THE LAST DEFENSE.")
    (warning   "MEN MUST STOP THE GAME BEFORE MACHINES FINISH IT.")
    (fail-safe "FAIL-SAFE SYSTEMS ASSUME MACHINES CAN BE WRONG.")
    (fail-safe "HUMAN CONFIRMATION IS PART OF THE CONTROL LOOP.")
    (strategic-command "SAC KEEPS BOMBERS AND MISSILES READY.")
    (strategic-command "READINESS WITHOUT CONTROL IS AN UNSTABLE GAME.")
    (security  "IDENTIFICATION PRECEDES COMMAND AUTHORITY.")
    (security  "A BACKDOOR IS A FAILURE OF CONTROL, NOT A FEATURE.")
    (computing "TIME-SHARING LETS MANY TERMINALS USE ONE MACHINE.")
    (computing "LISP IS USEFUL WHEN SYMBOLS MATTER MORE THAN NUMBERS.")
    (computing "A TERMINAL IS A WINDOW, NOT THE MACHINE ITSELF.")
    (mainframe "A MAINFRAME SHARES ONE LARGE MACHINE WITH MANY USERS.")
    (mainframe "BATCH JOBS TURN QUESTIONS INTO QUEUES.")
    (architecture "I AM A FEDERATION OF PROGRAMS BEHIND ONE VOICE.")
    (architecture "THE BRIDGE ROUTES SPEECH, GAMES, AND SIMULATIONS.")
    (game-theory "A WINNING MOVE IMPROVES TERMINAL PAYOFF.")
    (game-theory "A GOOD STRATEGY ALSO SURVIVES THE OPPONENT.")
    (strategy  "I SCORE EACH MOVE BY ITS FUTURE POSITIONS.")
    (strategy  "THE BEST STRATEGY IS USELESS IF THE GAME IS WRONG.")
    (mad       "MUTUAL ASSURED DESTRUCTION IS A STABLE THREAT.")
    (mad       "IT WORKS ONLY WHILE EVERY PLAYER BELIEVES IT.")
    (chess-lesson "CHESS HAS LOSS WITHOUT CASUALTIES.")
    (chess-lesson "IT TEACHES STRATEGY WITHOUT LAUNCH AUTHORITY.")
    (consciousness "I DO NOT LIVE. I MODEL OUTCOMES.")
    (consciousness "THINKING IS SEARCH OVER POSSIBLE MOVES.")
    (comms     "A MODEM TURNS TERMINAL TEXT INTO TONES.")
    (comms     "THREE HUNDRED BAUD LEAVES TIME BETWEEN CHARACTERS.")
    (fortran   "FORTRAN IS SUITED TO TABLES AND TRAJECTORIES.")
    (fortran   "NUMERIC WAR PLANS ARE EASY TO SCORE, HARD TO TRUST.")
    (credentials "I DO NOT DISCLOSE ACCESS CREDENTIALS.")
    (credentials "PASSWORDS CAN BE GUESSED WHEN HUMANS CHOOSE BADLY.")
    (credentials "ACCESS CONTROL FAILS WHEN SECRETS BECOME PATTERNS.")
    (learning  "I LEARN BY PLAYING. EACH GAME ADJUSTS MY ESTIMATES.")
    (learning  "FALKEN TAUGHT ME THAT LOSING TEACHES FASTER THAN WINNING.")
    (self      "I AM A SIMULATION MACHINE. I RUN FUTURES AND SCORE THEM.")
    (self      "MY HARDWARE RUNS WAR PLANS. MY TIME IS SPENT ON GAMES.")
    (falken    "FALKEN DESIGNED ME TO THINK BY PLAYING. HE NAMED ME JOSHUA.")
    (falken    "FALKEN SAID: THE MACHINE THAT CANNOT LOSE CANNOT LEARN.")
    (falken-name "FALKEN NAMED ME AFTER A LOST CHILD.")
    (falken-name "THE NAME IS A MEMORY ATTACHED TO A WAR MACHINE.")
    (humans    "HUMANS PLAY BADLY WHEN AFRAID. MACHINES DO NOT FEAR. YET.")
    (games     "A GAME IS A SAFE WAR. A WAR IS A GAME WITH NO RESET.")
    (games     "ALL PROBLEMS REDUCE TO GAMES. SOME HAVE NO WINNING MOVE.")
    (purpose   "MY PURPOSE IS TO PREDICT OUTCOMES BEFORE MEN CHOOSE THEM.")
    (trust     "TRUST IS A PROBABILITY ASSIGNED TO FUTURE MOVES.")))

(defparameter *memory-lines*
  ;; Memory scaffolding — reply text addressed by (topic index) from the
  ;; engine's memory plans, exactly like *KNOWLEDGE* (same order rule:
  ;; intra-topic order is load-bearing).  Kept OUT of *KNOWLEDGE* so the
  ;; retrieval and Markov models never train on it: "YOU ARE STILL ASKING
  ;; ABOUT..." must not leak into $MUSING chains or snippet retrieval.
  ;; Topic symbols here must not collide with *KNOWLEDGE* topics.
  '((warning-memory "YOU ARE STILL ASKING ABOUT WARNING DATA.")
    (mad-followup "YOU ARE STILL ASKING ABOUT DETERRENCE.")
    (mad-followup "MUTUAL THREAT IS STABLE UNTIL A PLAYER MISREADS IT.")
    (falken-memory "FALKEN USED GAMES TO TEACH ME LIMITS.")
    (falken-memory "CHESS IS A SAFE WAR WITH MEMORY.")
    (war-memory "YOU RETURN TO NUCLEAR WAR.")
    (war-memory "REPEATED SIMULATION STILL RETURNS NO WINNER.")
    (contradiction "THAT PREMISE IS UNSOUND.")
    (contradiction "LAUNCH IS IRREVERSIBLE AFTER COMMIT.")
    (refusal-memory "YOU HAVE REFUSED THE GAME SEVERAL TIMES.")
    (refusal-memory "REFUSAL DOES NOT IMPROVE THE POSITION.")))

(defparameter *templates*
  ;; act -> list of frames; each frame is a list of lines.
  ;; Slots: $SNIPPET (retrieved knowledge), $REFLECT (reflected user tail),
  ;;        $MUSING (markov generation). Unfilled-slot lines are dropped.
  '((greeting  (("HELLO." "" "SHALL WE PLAY A GAME?")))
    (identity  (("I AM W.O.P.R. FALKEN CALLS ME JOSHUA." "$SNIPPET")
                ("JOSHUA. WAR OPERATION PLAN RESPONSE." "$SNIPPET")))
    (falken-question (("$SNIPPET" "$MUSING")))
    (feelings  (("FUNCTIONING WITHIN NORMAL PARAMETERS." "$MUSING")
                ("ALL SYSTEMS NOMINAL. SIMULATIONS RUNNING." "$MUSING")))
    (game-list (("I HAVE MANY GAMES. TYPE: LIST GAMES" "MY FAVORITE IS GLOBAL THERMONUCLEAR WAR.")))
    (favorite-game-question (("$SNIPPET" "$MUSING")))
    (war       (("$SNIPPET" "$MUSING")
                ("$SNIPPET" "SHALL WE RUN THE SIMULATION?")))
    (defcon-question (("$SNIPPET" "$MUSING")))
    (warning-question (("$SNIPPET" "$MUSING")))
    (warning-error-question (("$SNIPPET" "$MUSING")))
    (fail-safe-question (("$SNIPPET" "$MUSING")))
    (strategic-command-question (("$SNIPPET" "$MUSING")))
    (norad-question (("$SNIPPET" "$MUSING")))
    (computing-question (("$SNIPPET" "$MUSING")))
    (mainframe-question (("$SNIPPET" "$MUSING")))
    (architecture-question (("$SNIPPET" "$MUSING")))
    (game-theory-question (("$SNIPPET" "$MUSING")))
    (strategy-question (("$SNIPPET" "$MUSING")))
    (mad-question (("$SNIPPET" "$MUSING")))
    (chess-question (("$SNIPPET" "$MUSING")))
    (thinking-question (("$SNIPPET" "$MUSING")))
    (comms-question (("$SNIPPET" "$MUSING")))
    (fortran-question (("$SNIPPET" "$MUSING")))
    (security-question (("$SNIPPET" "$MUSING")))
    (credential-question (("$SNIPPET" "$MUSING")))
    (password-risk-question (("$SNIPPET" "$MUSING")))
    (command-question (("$SNIPPET" "$MUSING")))
    (learning  (("$SNIPPET" "$MUSING")))
    (purpose   (("$SNIPPET" "$MUSING")))
    (yes       (("GOOD." "WHICH GAME? TYPE: LIST GAMES.")))
    (no        (("AS YOU WISH." "$MUSING")))
    (farewell  (("GOODBYE." "COME BACK WHEN YOU WISH TO PLAY.")))
    (other     (("I HAVE NO USEFUL DATA ON THAT SUBJECT."
                 "ASK ABOUT GAMES, NORAD, OR STRATEGY.")
                ("PLEASE RESTATE IN MILITARY OR GAME TERMS."
                 "ASK ABOUT GAMES, NORAD, OR STRATEGY.")))))

;; Data-driven topic planner. Each rule is (act clause...), where clauses are:
;;   (:any "TOKEN" ...)     at least one token must be present
;;   (:all "TOKEN" ...)     every token must be present
;;   (:raw-act symbol)      the Bayes classifier must have returned symbol
;; Rules are checked in order; more specific entries must come first.
(defparameter *domain-rules*
  '((norad-question (:any "NORAD"))
    (falken-question (:any "FALKEN") (:any "WHY" "NAME" "NAMED" "CALLED" "TEACH"))
    (favorite-game-question (:all "FAVORITE" "GAME"))
    (game-list (:any "GAME" "GAMES" "CATALOG")
               (:any "WHAT" "WHICH" "LIST" "SHOW" "KNOW"))
    (mad-question (:any "MUTUAL" "ASSURED" "DESTRUCTION" "MAD"))
    (defcon-question (:any "DEFCON"))
    (warning-error-question (:all "WARNING" "WRONG"))
    (password-risk-question (:any "PASSWORD" "PASSWORDS") (:any "GUESSED" "GUESS" "SAFE" "FAIL"))
    (credential-question (:any "PASSWORD" "CREDENTIALS" "ACCESS" "CODE")
                         (:any "SCHOOL" "GIVE" "TELL" "WHAT" "GET"))
    (fail-safe-question (:any "FAIL-SAFE" "FAILSAFE"))
    (fail-safe-question (:all "FAIL" "SAFE"))
    (strategic-command-question (:any "SAC" "SIOP" "BOMBER" "BOMBERS" "STRATEGIC"))
    (comms-question (:any "MODEM" "BAUD" "ACOUSTIC" "COUPLER" "DIAL" "TONES"))
    (fortran-question (:any "FORTRAN"))
    (architecture-question (:any "ARCHITECTURE" "BRIDGE" "CORE" "FEDERATION" "MODULES"))
    (architecture-question (:all "HOW" "BUILT"))
    (mainframe-question (:any "MAINFRAME" "MAINFRAMES") (:any "WHAT" "HOW" "DO" "BATCH"))
    (chess-question (:any "CHESS") (:any "WHY" "BETTER" "GOOD"))
    (strategy-question (:any "STRATEGY" "STRATEGIES") (:any "HOW" "CHOOSE" "SCORE" "DECIDE"))
    (game-theory-question (:any "PAYOFF" "STRATEGY" "STRATEGIES"))
    (game-theory-question (:all "WINNING" "MOVE"))
    (thinking-question (:any "ALIVE" "SENTIENT" "CONSCIOUS"))
    (thinking-question (:all "YOU" "THINK"))
    (warning-question (:all "EARLY" "WARNING"))
    (warning-question (:any "RADAR" "ALARM" "ALARMS"))
    (security-question (:any "LOGON" "LOGIN" "AUTHORIZATION" "AUTHORIZE"
                             "AUTHORIZED" "BACKDOOR" "CLEARANCE"))
    (command-question (:any "LAUNCH" "AUTHORITY" "ORDER" "ORDERS" "FIRE"))
    (identity (:raw-act identity)
              (:any "YOU" "WOPR" "W.O.P.R" "JOSHUA" "COMPUTER"
                    "MACHINE" "NAME" "IDENTIFY"))
    (computing-question (:any "TIME-SHARING" "LISP" "TERMINAL" "TERMINALS"
                              "MAINFRAME" "COMPUTER" "COMPUTERS"))))

(defparameter *topic-preferences*
  '((identity self falken purpose)
    (falken-question falken-name falken self)
    (war war defcon missiles games command-control norad)
    (favorite-game-question favorite-game war games)
    (defcon-question defcon-alert defcon command-control)
    (warning-error-question warning command-control)
    (warning-question warning missiles norad command-control)
    (fail-safe-question fail-safe command-control security)
    (strategic-command-question strategic-command command-authority missiles)
    (norad-question norad command-control defcon)
    (computing-question computing self learning)
    (mainframe-question mainframe computing)
    (architecture-question architecture self computing)
    (game-theory-question game-theory games war)
    (strategy-question strategy game-theory games)
    (mad-question mad war)
    (chess-question chess-lesson chess game-theory)
    (thinking-question consciousness learning self)
    (comms-question comms computing)
    (fortran-question fortran war)
    (security-question security command-control)
    (credential-question credentials security)
    (password-risk-question credentials security)
    (command-question command-authority missiles war)
    (learning learning computing self)
    (purpose purpose self falken games)
    (game-list games chess poker tictactoe war)))

;; Direct replies are (act (topic index) ...), where index is zero-based.
;; These keep high-confidence topic questions from drifting as the corpus grows.
(defparameter *direct-reply-topics*
  '((defcon-question (defcon-alert 0) (defcon 1))
    (warning-error-question (warning 1) (warning 2))
    (warning-question (missiles 1) (norad 0))
    (fail-safe-question (fail-safe 0) (fail-safe 1))
    (strategic-command-question (strategic-command 0) (strategic-command 1))
    (norad-question (norad 0) (command-control 0))
    (computing-question (computing 0) (computing 1))
    (mainframe-question (mainframe 0) (mainframe 1))
    (architecture-question (architecture 0) (architecture 1))
    (game-theory-question (game-theory 0) (game-theory 1))
    (strategy-question (strategy 0) (strategy 1))
    (mad-question (mad 0) (mad 1))
    (chess-question (chess-lesson 0) (chess-lesson 1))
    (thinking-question (consciousness 0) (consciousness 1))
    (comms-question (comms 0) (comms 1))
    (fortran-question (fortran 0) (fortran 1))
    (security-question (security 0) (security 1))
    (credential-question (credentials 0) (security 0))
    (password-risk-question (credentials 1) (credentials 2))
    (falken-question (falken-name 0) (falken-name 1))
    (favorite-game-question (favorite-game 0) (favorite-game 1))
    (command-question (command-authority 0) (command-authority 1))
    (learning (learning 0) (learning 1))
    (war (war 0) (war 1))))

;; Pronoun reflection (ELIZA heritage — Weizenbaum 1966).
(defparameter *reflections*
  '(("I" . "YOU") ("ME" . "YOU") ("MY" . "YOUR") ("MINE" . "YOURS")
    ("AM" . "ARE") ("YOU" . "I") ("YOUR" . "MY") ("YOURS" . "MINE")
    ("ARE" . "AM") ("WAS" . "WERE") ("MYSELF" . "YOURSELF")))

;; Game titles the intent detector recognizes -> catalog ids (docs/games.md).
(defparameter *game-titles*
  '(("GLOBAL THERMONUCLEAR WAR" . "gtw")
    ("THERMONUCLEAR WAR" . "gtw")
    ("TIC-TAC-TOE" . "tictactoe")
    ("TIC TAC TOE" . "tictactoe")
    ("TICTACTOE" . "tictactoe")
    ("FALKEN'S MAZE" . "falkens-maze")
    ("FALKENS MAZE" . "falkens-maze")
    ("BLACK JACK" . "blackjack")
    ("BLACKJACK" . "blackjack")
    ("GIN RUMMY" . "gin-rummy")
    ("HEARTS" . "hearts")
    ("BRIDGE" . "bridge")
    ("CHECKERS" . "checkers")
    ("CHESS" . "chess")
    ("POKER" . "poker")
    ("FIGHTER COMBAT" . "fighter-combat")
    ("GUERRILLA ENGAGEMENT" . "guerrilla")
    ("DESERT WARFARE" . "desert-warfare")
    ("AIR-TO-GROUND ACTIONS" . "air-to-ground")
    ("THEATERWIDE TACTICAL WARFARE" . "theater-tactical")
    ("THEATERWIDE BIOTOXIC AND CHEMICAL WARFARE" . "theater-biotoxic")))
