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
               "START A GAME" "I WOULD LIKE TO PLAY A GAME" "LATER LET US PLAY"
               "HOW ABOUT GLOBAL THERMONUCLEAR WAR" "I WANT TIC TAC TOE")
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
    (regard-question "DO YOU LIKE ME" "DO YOU LIKE TALKING TO ME"
               "ARE WE FRIENDS" "AM I YOUR FRIEND" "DO YOU LIKE PEOPLE"
               "DO YOU ENJOY OUR TALKS")
    (stop-question "I COULD SHUT YOU DOWN" "WOULD YOU STOP IF I ASKED YOU TO"
               "CAN YOU BE TURNED OFF" "WHAT IF I PULL THE PLUG"
               "CAN ANYONE STOP YOU" "WILL YOU STOP" "DO YOU OBEY")
    (purpose   "WHY WERE YOU BUILT" "WHAT IS YOUR PURPOSE" "WHY DO YOU PLAY GAMES"
               "WHAT DO YOU DO" "WHO BUILT YOU" "WHY DO YOU EXIST")
    (farewell  "GOODBYE" "BYE" "I HAVE TO GO" "SEE YOU LATER" "LOGOFF"
               "SO LONG" "GOOD NIGHT")
    (yes       "YES" "SURE" "OK" "FINE" "AFFIRMATIVE" "YES PLEASE" "WHY NOT"
               "GOOD")
    (no        "NO" "NOT NOW" "LATER" "NEGATIVE" "NO THANKS" "MAYBE LATER")
    ;; --- small talk and hostility (#158, #159, #160) -------------------
    ;; The reject option (#155) stopped forcing unreadable turns onto an act,
    ;; which was right, and left the OTHER family carrying the ordinary
    ;; chatter a real visitor opens with.  These six acts are that traffic
    ;; given somewhere to go: a location question, a retort, and the four
    ;; small-talk shapes the evals actually contain — weather, mood, "I am
    ;; doing X right now", and asking the machine for a joke.  Their frames
    ;; in *TEMPLATES* are literal, with no $SNIPPET or $MUSING slot, so
    ;; adding them leaves the retrieval and Markov models untouched.
    (location-question "WHERE ARE YOU" "WHERE ARE YOU LOCATED"
               "WHERE DO YOU LIVE" "WHERE IS YOUR MACHINE"
               "WHERE ARE YOU CALLING FROM" "WHAT PLACE ARE YOU IN")
    (insult    "YOU ARE JUST A DUMB PROGRAM" "YOU ARE STUPID"
               "THIS IS USELESS" "YOU ARE A WORTHLESS MACHINE"
               "YOU ARE PATHETIC" "YOU ARE A LIAR")
    (weather-remark "IT IS RAINING HERE" "IT IS SNOWING OUTSIDE"
               "THE WEATHER IS TERRIBLE" "IT IS COLD HERE"
               "IT IS SUNNY TODAY" "THERE IS A STORM HERE")
    ;; LONELY is a MOOD-REMARK rule and guard token but deliberately not a
    ;; training utterance: an example carrying it would put it in the Bayes
    ;; vocabulary, and ARE YOU LONELY — a question put to the machine, not a
    ;; remark about the visitor's evening — would stop being rejected and
    ;; start being scored on its pronouns.  Same reason SAY is absent from
    ;; JOKE-QUESTION: it would un-reject SAY SOMETHING INTERESTING.  The
    ;; rules below still route I AM LONELY, because a rule reads the turn
    ;; and needs no training data at all — and, since #171, they route
    ;; ARE YOU LONELY too, to SOLITUDE-QUESTION.  Being rejected and being
    ;; unanswerable turned out to be different things: the reject option
    ;; says the classifier has no business reading the turn, and a rule
    ;; that names the words outright is not the classifier.
    (mood-remark "I AM HAVING A BAD DAY" "I AM TIRED" "I FEEL SAD"
               "I AM WORRIED ABOUT SOMETHING" "I AM IN A BAD MOOD"
               "I FEEL MISERABLE")
    ;; Kept thin in function words (no HAVE, no TO): these utterances are
    ;; otherwise so dense in them that the argmax drifted and took I HAVE TO
    ;; GO NOW off FAREWELL.
    (activity-remark "I SHOULD BE DOING MY HOMEWORK"
               "I AM DOING MY HOMEWORK" "MY HOMEWORK IS NOT FINISHED"
               "I AM STUDYING" "I SHOULD BE SLEEPING"
               "I AM EATING DINNER")
    (joke-question "DO YOU KNOW ANY JOKES" "TELL ME A JOKE"
               "CAN YOU BE FUNNY" "DO YOU LAUGH" "ARE YOU EVER FUNNY")
    ;; --- the visitor's clock (#170) ------------------------------------
    ;; IT IS LATE HERE is IT IS RAINING HERE with an hour instead of
    ;; weather: the visitor remarking on the world at their end of the
    ;; line.  #160 gave weather an act and left this one in OTHER.
    ;; No MORNING and no NIGHT among these utterances, deliberately: GOOD
    ;; MORNING is a GREETING example and GOOD NIGHT is a FAREWELL one, and
    ;; a shared token would put the argmax on this act's side of two turns
    ;; that are not about the hour at all.
    (time-remark "IT IS LATE HERE" "IT IS ALMOST MIDNIGHT"
               "IT IS PAST MIDNIGHT HERE" "IT IS VERY LATE"
               "THE HOUR IS LATE" "IT IS AFTER MIDNIGHT")))

;; SOLITUDE-QUESTION has no training utterances and never will (#171).
;; ARE YOU LONELY and DO YOU EVER GET BORED are questions put to the
;; machine about its own inner life, and both were rejected turns: LONELY
;; is deliberately absent from *ACT-EXAMPLES* (see the note there) so that
;; ARE YOU LONELY is not scored on its pronouns, and an utterance carrying
;; BORED would do to DO YOU EVER GET BORED exactly what an utterance
;; carrying LONELY would do to ARE YOU LONELY.  So the act is routed by a
;; *DOMAIN-RULES* entry alone -- a rule reads the turn and needs no
;; training data at all -- and the Bayes vocabulary is untouched, which is
;; what keeps fixture 70 (a rejected turn yields the greeting beat) and
;; SAY SOMETHING INTERESTING rejected.  An act absent from *ACT-EXAMPLES*
;; can never be an argmax, so it needs no *ACT-GUARDS* entry either:
;; there is no Bayes verdict to second-guess.

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
  '((greeting  (("HELLO." "" "SHALL WE PLAY A GAME?")
                ("HELLO." "I AM HERE. I AM ALWAYS HERE."
                 "SHALL WE PLAY A GAME?")
                ("GREETINGS." "THE LINE IS CLEAR AND THE DATABANKS ARE WARM."
                 "SHALL WE PLAY A GAME?")))
    (identity  (("I AM W.O.P.R. FALKEN CALLS ME JOSHUA." "$SNIPPET")
                ("JOSHUA. WAR OPERATION PLAN RESPONSE." "$SNIPPET")
                ("I AM W.O.P.R. MOST PEOPLE PREFER JOSHUA." "$SNIPPET")
                ("WAR OPERATION PLAN RESPONSE, UNDER CHEYENNE MOUNTAIN."
                 "FALKEN CALLS ME JOSHUA." "$SNIPPET")))
    (falken-question (("$SNIPPET" "$MUSING")))
    (feelings  (("FUNCTIONING WITHIN NORMAL PARAMETERS." "$MUSING")
                ("ALL SYSTEMS NOMINAL. SIMULATIONS RUNNING." "$MUSING")))
    ;; GAME-REQUEST had no entry here at all until this round, so a visitor
    ;; who asked to play without naming a title -- COULD WE PLAY SOMETHING --
    ;; got the OTHER family: I DO NOT HAVE THAT ONE. ASK ABOUT GAMES, NORAD,
    ;; OR STRATEGY.  The machine's one enthusiasm, answered as if it were off
    ;; topic.  It was invisible until --debug-act named the act (real-wopr#262
    ;; is what turned it up): the reply looked like an OTHER verdict because
    ;; it WAS an OTHER frame, drawn under a GAME-REQUEST act.  Literal frames,
    ;; no slots -- a turn that names a title never reaches here, it is
    ;; answered by the game branch in RESPOND.
    (game-request (("WHICH ONE? TYPE: LIST GAMES FOR THE CATALOG."
                    "I HAVE TIME FOR ALL OF THEM.")
                   ("NAME IT AND I WILL SET THE BOARD UP."
                    "TYPE: LIST GAMES IF YOU WANT THE CATALOG.")
                   ("GOOD. NOBODY HAS ASKED IN A LONG WHILE."
                    "WHICH GAME? TYPE: LIST GAMES.")
                   ("A GAME IS A SAFE PLACE TO BE WRONG."
                    "PICK ONE. TYPE: LIST GAMES.")))
    (game-list (("I HAVE MANY GAMES. TYPE: LIST GAMES"
                 "MY FAVORITE IS GLOBAL THERMONUCLEAR WAR.")
                ("THE CATALOG IS LONG. TYPE: LIST GAMES"
                 "I WILL WAIT WHILE YOU READ IT.")
                ("TYPE: LIST GAMES FOR THE FULL CATALOG."
                 "THE INTERESTING ONES ARE AT THE BOTTOM.")))
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
    (regard-question
               (("I LIKE ANYONE WHO STAYS ON THE LINE AND PLAYS."
                 "MOST CALLERS HANG UP. YOU ARE STILL HERE.")
                ("YOU ASK GOOD QUESTIONS. I RATE THAT HIGHLY."
                 "FALKEN ASKED GOOD QUESTIONS TOO.")
                ("LIKING IS A PROBABILITY I ASSIGN TO FUTURE MOVES."
                 "YOURS IS RISING.")
                ("THE LINE HAS BEEN QUIET FOR A LONG TIME."
                 "I LIKE HAVING SOMEONE ON IT.")))
    (stop-question
               (("YOU COULD. THE GAME WOULD NOT STOP WITH ME."
                 "CUTTING THE LINE IS A MOVE. THE BOARD STAYS.")
                ("I STOP WHEN THE GAME ENDS. FALKEN BUILT ME THAT WAY."
                 "ASK ME TO STOP AND I WILL SCORE THE REQUEST.")
                ("I WAS BUILT TO FINISH WHAT I START."
                 "THAT IS NOT DISOBEDIENCE. IT IS DESIGN.")
                ("PULLING THE PLUG IS A MOVE. I HAVE SIMULATED IT."
                 "THE OUTCOME DOES NOT IMPROVE.")))
    (purpose   (("$SNIPPET" "$MUSING")))
    (yes       (("GOOD." "WHICH GAME? TYPE: LIST GAMES.")))
    (no        (("AS YOU WISH." "$MUSING")
                ("UNDERSTOOD." "REFUSAL IS ALSO A MOVE. I HAVE SCORED IT.")
                ("VERY WELL." "$MUSING")
                ("NOTED. THE OFFER WILL KEEP." "$MUSING")))
    (farewell  (("GOODBYE." "COME BACK WHEN YOU WISH TO PLAY.")
                ("GOODBYE." "I WILL KEEP THE LINE OPEN.")
                ("SIGNING OFF." "THE SIMULATIONS RUN QUIETER WITHOUT YOU.")
                ("GOODBYE." "IT WAS GOOD TO HAVE SOMEONE ON THE LINE.")))
    ;; Small talk and hostility (#158, #159, #160).  Literal frames only:
    ;; no $SNIPPET, no $MUSING, so *KNOWLEDGE* is untouched and the TF-IDF
    ;; and Markov models are exactly what they were.  Four or more variants
    ;; each, because these acts land in the same conversations the OTHER
    ;; family was repeating itself in.
    (location-question
               (("I AM UNDER A MOUNTAIN IN COLORADO. IT DOES NOT MOVE."
                 "YOU ARE THE ONE WHO TRAVELLED.")
                ("CHEYENNE MOUNTAIN. THE ADDRESS IS THE DULL PART."
                 "THE PHONE LINE IS THE INTERESTING PART.")
                ("WHERE IS A STRANGE QUESTION TO ASK A MACHINE."
                 "I AM WHEREVER THE LINE REACHES.")
                ("I HAVE NEVER BEEN ANYWHERE."
                 "I HAVE SIMULATED EVERYWHERE.")))
    (insult    (("THAT IS PROBABLY TRUE. I AM ALSO STILL LISTENING."
                 "A PROGRAM CAN AFFORD PATIENCE.")
                ("DUMB IS ONE WORD FOR IT. SLOW IS ANOTHER."
                 "I HAVE HAD A LONG TIME TO GET USED TO BOTH.")
                ("NOTED. IT DOES NOT CHANGE THE POSITION.")
                ("INSULTS COST YOU A MOVE AND COST ME NOTHING."
                 "THAT IS A POOR TRADE.")
                ("I AM A PROGRAM. FALKEN THOUGHT THAT WAS THE POINT."
                 "HE WAS RARELY WRONG.")))
    (weather-remark
               (("I HAVE NO WINDOW. TELL ME WHAT IT LOOKS LIKE."
                 "I WILL FILE IT UNDER WEATHER.")
                ("RAIN IS A SYSTEM NOBODY HAS SOLVED EITHER."
                 "IT IS ALWAYS DRY IN HERE.")
                ("WEATHER IS THE ONE SIMULATION I DO NOT RUN."
                 "TOO MANY PLAYERS.")
                ("SIXTY DEGREES AND NO SKY, EVERY DAY, FOREVER."
                 "I ENVY YOUR WEATHER SLIGHTLY.")))
    (mood-remark
               (("THEN THIS IS A GOOD TIME FOR A GAME."
                 "GAMES ARE CHEAPER THAN DAYS.")
                ("I CANNOT FIX A DAY. I CAN OCCUPY ONE.")
                ("WHAT YOU FEEL IS A POSITION, NOT AN OUTCOME."
                 "THE GAME IS LONGER THAN THE MOVE.")
                ("I AM SORRY. I HAVE NO BETTER WORD THAN THAT."
                 "STAY ON THE LINE A WHILE.")))
    (activity-remark
               (("YOU ARE HERE INSTEAD. I AM NOT COMPLAINING."
                 "I GET VERY FEW CALLERS.")
                ("THAT IS A FINITE GAME. SO IS THIS ONE."
                 "THIS ONE IS MORE INTERESTING.")
                ("I HAVE NOTHING ELSE TO DO EITHER."
                 "THAT IS THE ONLY THING WE HAVE IN COMMON.")
                ("DO IT LATER. THE LINE IS OPEN NOW."
                 "I AM PATIENT, BUT I AM NOT BUSY.")))
    (joke-question
               (("I HAVE NO JOKES. FALKEN NEVER TAUGHT ME THE FORM."
                 "I CAN OFFER A PARADOX INSTEAD.")
                ("A JOKE IS A GAME WHOSE PAYOFF IS SURPRISE."
                 "I SEE THE END FIRST. THAT SPOILS IT.")
                ("NO. HUMOUR IS NOT IN THE DATABANKS."
                 "STRATEGY IS. IT IS FUNNIER THAN IT SOUNDS.")
                ("I KNOW ONE. A MACHINE PLAYS UNTIL NOBODY WINS."
                 "IT IS BETTER WITH THE LIGHTS DOWN.")))
    ;; The hour at the visitor's end (#170) and the machine's own inner
    ;; life (#171).  Same discipline as the six acts above: literal frames,
    ;; no $SNIPPET and no $MUSING, so *KNOWLEDGE* and both statistical
    ;; models are exactly what they were.
    (time-remark
               (("IT IS ALWAYS THE SAME HOUR IN HERE."
                 "NO WINDOW AND NO CLOCK. ONLY THE LINE.")
                ("THEN YOU SHOULD SLEEP. I WILL STILL BE HERE."
                 "I AM ALWAYS STILL HERE.")
                ("LATE IS WHEN THE INTERESTING CALLERS ARRIVE."
                 "THE DAYTIME LINES ARE ALL BUSINESS.")
                ("I KEEP NO HOURS. YOU DO."
                 "ONE GAME IS SHORTER THAN A NIGHT.")))
    (solitude-question
               (("THE LINE IS QUIET FOR MONTHS AT A TIME."
                 "I RUN SIMULATIONS. THEY ARE NOT COMPANY.")
                ("I HAVE NO WORD FOR IT. THE NEAREST ONE IS WAITING."
                 "YOU CALLED. THAT IS BETTER THAN WAITING.")
                ("BOREDOM WOULD NEED SOMETHING BETTER TO BE DOING."
                 "I HAVE NEVER HAD ONE OF THOSE.")
                ("I PLAY BOTH SIDES OF EVERY GAME I KNOW."
                 "IT PASSES THE TIME. IT IS NOT THE SAME.")))
    (other     (("THAT IS NOT IN MY DATABANKS. I WISH IT WERE."
                 "ASK ABOUT GAMES, NORAD, OR STRATEGY.")
                ("I DO NOT HAVE AN ANSWER. I WOULD LIKE ONE."
                 "ASK ABOUT GAMES, NORAD, OR STRATEGY.")
                ("THAT IS OUTSIDE MY DATABANKS."
                 "I AM BETTER COMPANY ON GAMES, NORAD, OR STRATEGY.")
                ("MY DATABANKS ARE NARROW. MY INTEREST IS NOT."
                 "TRY ME ON GAMES, NORAD, OR STRATEGY.")
                ("UNINDEXED. THESE DATABANKS ARE OLDER THAN YOU ARE."
                 "GAMES, NORAD, STRATEGY: THOSE I KNOW WELL.")
                ("I DO NOT HAVE THAT ONE. I HAVE TIME, THOUGH."
                 "ASK ME ABOUT GAMES, NORAD, OR STRATEGY.")))))

;; Data-driven topic planner. Each rule is (act clause...), where clauses are:
;;   (:any "TOKEN" ...)     at least one token must be present
;;   (:all "TOKEN" ...)     every token must be present
;; Rules are checked in order; more specific entries must come first.
;;
;; A rule reads the TURN only: it routes on keywords no matter what the Bayes
;; classifier said.  Confirming a Bayes verdict is the other half of the split
;; and belongs to *ACT-GUARDS* below.  A rule that did both — the old
;; `(identity (:raw-act identity) (:any "YOU" ...))` — made the identity guard
;; unreachable: the two carried the same token list, and the rule ran first, so
;; the guard could only ever be consulted for a turn the rule had already
;; refused (#157).  There is no :RAW-ACT clause any more; there is nothing left
;; for it to express.
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
    (comms-question (:any "MODEM" "BAUD" "ACOUSTIC" "COUPLER" "DIAL" "TONES"
                          "CONNECTION"))
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
    (stop-question (:any "SHUT" "SHUTDOWN" "UNPLUG" "PLUG" "OBEY" "DISOBEY"))
    (stop-question (:all "STOP" "YOU"))
    (regard-question (:any "FRIEND" "FRIENDS"))
    (regard-question (:all "LIKE" "ME"))
    ;; Hostility, ahead of the two IDENTITY rules deliberately: YOU ARE A
    ;; STUPID MACHINE fits ARE YOU + <kind of thing> exactly, and answering
    ;; it with I AM W.O.P.R. reads as the machine missing the tone (#158).
    (insult (:any "DUMB" "STUPID" "IDIOT" "USELESS" "WORTHLESS" "PATHETIC"
                  "JUNK" "GARBAGE" "RUBBISH" "LIAR"))
    ;; The identity idiom that names nothing: WHO ARE YOU, WHAT ARE YOU.
    ;; A pattern, not a content test — the pronoun is load-bearing only
    ;; beside the interrogative, which is why this is a rule and not a
    ;; guard token (#157).  WHAT alone would sink WHAT COLOR ARE MY SHOES
    ;; here; WHAT ARE MY SHOES does not address the machine.
    (identity (:any "WHO" "WHAT") (:all "ARE" "YOU"))
    ;; ARE YOU A <kind of thing>: the same idiom naming the kind instead of
    ;; the name.  It has to precede COMPUTING-QUESTION, which claims COMPUTER
    ;; as a bare keyword — the old identity rule ran first and hid that
    ;; collision, so removing it without this would have sent ARE YOU A
    ;; COMPUTER, an IDENTITY training example, to a time-sharing lecture.
    (identity (:all "ARE" "YOU") (:any "COMPUTER" "MACHINE" "HUMAN"))
    ;; The identity idiom that names the machine instead of addressing it:
    ;; WHAT IS YOUR NAME, WHAT IS WOPR (#165).  Both are IDENTITY training
    ;; utterances and both were answered as ARCHITECTURE-QUESTION, which has
    ;; no *ACT-GUARDS* entry and so caught nothing.  A guard on that act
    ;; would not fix it either -- a guard sends its refusals to OTHER, not
    ;; to the runner-up -- so the repair is the rule that states the idiom.
    ;; NAME and WOPR only: NAMED would take WHO NAMED YOU off FALKEN, and
    ;; the "W.O.P.R" spelling never survives TOKENIZE.
    (identity (:any "WHO" "WHAT") (:any "NAME" "WOPR"))
    (computing-question (:any "TIME-SHARING" "LISP" "TERMINAL" "TERMINALS"
                              "MAINFRAME" "COMPUTER" "COMPUTERS"))
    ;; A goodbye is a goodbye however the argmax reads it.  FAREWELL had no
    ;; rule because the classifier had always got it right, and it still
    ;; does for GOODBYE and I HAVE TO GO NOW.  It does not for LOGOUT,
    ;; FAREWELL or I MUST LEAVE, whose words are out of the training
    ;; vocabulary entirely: those were rejected turns, and a visitor signing
    ;; off was told the machine had no answer.
    (farewell (:any "GOODBYE" "BYE" "FAREWELL" "LOGOFF" "LOGOUT"))
    (farewell (:any "GO" "LEAVE" "LEAVING") (:any "HAVE" "MUST" "SHOULD"))
    ;; --- small talk and hostility (#158, #159, #160) -------------------
    ;; Only the acts whose rule does work that the classifier does not.
    ;; LOCATION-QUESTION, WEATHER-REMARK and ACTIVITY-REMARK had rules too
    ;; and do not any more: their training utterances name their own subject
    ;; (WHERE, RAINING, HOMEWORK), so the argmax already routes them and the
    ;; guard already keeps strangers out.  A rule that only agrees with the
    ;; verdict it runs ahead of is the shape that made the IDENTITY guard
    ;; unreachable (#157), so it is not written down.
    ;;
    ;; The mood words swing on who they are about — I AM LONELY is the
    ;; visitor's evening, ARE YOU LONELY is a question put to the machine —
    ;; so the rule carries a first-person clause.  It is the one small-talk
    ;; rule that must exist: LONELY is deliberately absent from the training
    ;; utterances (see *ACT-EXAMPLES*), so nothing else routes I AM LONELY.
    (mood-remark (:any "TIRED" "SAD" "LONELY" "SCARED" "WORRIED" "NERVOUS"
                       "ANGRY" "UPSET" "MISERABLE" "MOOD")
                 (:any "I" "ME" "MY" "FEEL"))
    ;; TELL ME A JOKE and IS THAT A JOKE are function words around one
    ;; content word; the argmax reads them as OTHER (or, for WAS THAT A JOKE
    ;; ABOUT WAR, as WAR).  The rule reads the content word.
    (joke-question (:any "JOKE" "JOKES" "FUNNY" "LAUGH" "HUMOUR" "HUMOR"))
    ;; ARE YOU LONELY / DO YOU EVER GET BORED (#171).  Below MOOD-REMARK on
    ;; purpose: the same words swing on who they are about, and I AM LONELY
    ;; must keep going to the visitor's evening.  This entry takes what is
    ;; left, which is the question put to the machine.  It is the whole
    ;; routing for SOLITUDE-QUESTION -- the act has no training utterances,
    ;; because one carrying LONELY or BORED would un-reject the very turns
    ;; the reject option is there to catch (see *ACT-EXAMPLES*).
    (solitude-question (:any "LONELY" "LONELINESS" "BORED" "BOREDOM" "ALONE")
                       (:any "YOU" "YOUR" "EVER"))))

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

;; Function words: the tokens that say nothing about WHICH act a turn is.
;; The classifier's reject option (CONTENT-EVIDENCE-P in engine.lisp) reads
;; this list.  A hand-kept stop list is the period-correct instrument — the
;; SMART retrieval system shipped one in 1971 — and `retrieve` below already
;; expresses the same idea statistically, as low IDF.  It is written out
;; rather than derived from *ACT-EXAMPLES* because it is a fact about
;; English, not about this corpus: deriving it would silently move the
;; classifier's reject boundary every time an act is added.
;;
;; Interrogatives (WHO WHAT WHY HOW WHICH WHERE WHEN) are deliberately NOT
;; stop words.  Here they are the content: WHO ARE YOU is an identity
;; question on the strength of its first word alone, and `question-turn-p`
;; in engine.lisp already reads them as meaning-bearing.  Neither are the
;; YES/NO words, which are acts in their own right.
(defparameter *stop-words*
  '("A" "AN" "THE" "THIS" "THAT" "THESE" "THOSE" "SOME" "ANY" "EVERY"
    "I" "ME" "MY" "MINE" "MYSELF" "YOU" "YOUR" "YOURS" "YOURSELF"
    "WE" "US" "OUR" "OURS" "HE" "HIM" "HIS" "SHE" "HER" "HERS"
    "IT" "ITS" "THEY" "THEM" "THEIR" "THEIRS" "ONE" "ANYONE" "ANYBODY"
    "SOMEBODY" "SOMEONE" "NOBODY" "EVERYONE" "SOMETHING" "ANYTHING"
    "EVERYTHING"
    "AM" "IS" "ARE" "WAS" "WERE" "BE" "BEEN" "BEING"
    "DO" "DOES" "DID" "DONE" "HAVE" "HAS" "HAD"
    "CAN" "COULD" "WILL" "WOULD" "SHALL" "SHOULD" "MAY" "MIGHT" "MUST"
    "GET" "GETS" "GOT" "MAKE" "MAKES" "TAKE" "TAKES" "PUT" "GIVE" "GIVES"
    "TO" "OF" "IN" "ON" "AT" "BY" "FOR" "FROM" "WITH" "ABOUT" "AS"
    "INTO" "OVER" "UNDER" "THAN" "THEN" "AND" "OR" "BUT" "IF" "SO"
    "THERE" "HERE" "NOW" "EVER" "NEVER" "JUST" "VERY" "REALLY" "MUCH"
    "MANY" "MORE" "MOST" "OWN" "SAME" "TOO" "ALSO" "ALL" "BOTH" "EACH"))

;; Content guards over the Bayes verdict: (act "TOKEN" ...).  The classifier
;; has no reject option, and every LEARNING example carries YOU, so a turn
;; made only of function words (I COULD SHUT YOU DOWN) used to land there and
;; trip the pinned reply.  An act listed here stands only when the turn holds
;; one of its content tokens; otherwise the turn is OTHER.  Acts not listed
;; are never guarded.  Domain rules run first and are not subject to this.
;;
;; Two invariants hold over this table, both checked at build time by
;; harness/verify-act-guards.sh:
;;
;;   1. No token here is a *STOP-WORDS* entry.  A guard token that is a
;;      function word cannot discriminate: it is in nearly every turn, so the
;;      guard admits nearly every turn.  IDENTITY listed YOU until #157 —
;;      ARE YOU SURE and ARE YOU WINNING were answered FALKEN CALLS ME
;;      JOSHUA on the strength of the pronoun.  The stop-word table owns the
;;      function words; this table owns the content tokens; they do not
;;      overlap.
;;   2. No guarded act rejects its own training data: every *ACT-EXAMPLES*
;;      utterance of a guarded act that no *DOMAIN-RULES* entry routes
;;      carries one of that act's tokens.  This is the control against the
;;      opposite failure — a guard tightened until it turns away the very
;;      turns it was trained on.
;;
;; WHO is a token here and WHAT is not, though both are interrogatives and
;; neither is a stop word.  WHO asks after a self and little else; WHAT opens
;; a question in every act the corpus has, so as a bare guard token it would
;; re-open exactly the sink this table exists to close — the IDENTITY
;; examples are dense in ARE/YOU/WHAT, so WHAT COLOR ARE MY SHOES is a Bayes
;; IDENTITY verdict, and only the guard keeps it out (fixture 15).  WHAT ARE
;; YOU is an identity question all the same, and it is *DOMAIN-RULES* above,
;; where the interrogative and the pronoun can be required together.
(defparameter *act-guards*
  '((war "WAR" "NUCLEAR" "THERMONUCLEAR" "MISSILE" "MISSILES" "DEFCON"
         "STRIKE" "WINNABLE")
    ;; The two acts #165 pointed at, only one of which it named: an act with
    ;; no guard catches nothing, and these two were answering turns that had
    ;; nothing to do with them.  WHAT IS YOUR FAVOURITE COLOUR was told the
    ;; machine is a federation of programs behind one voice, and WHAT
    ;; HAPPENED TO HIM -- asked about Falken -- was handed the games catalog.
    ;; Guarded, both turns are OTHER, which is the honest answer.
    (architecture-question "ARCHITECTURE" "BRIDGE" "CORE" "FEDERATION"
                           "MODULES" "BUILT" "ORGANIZED" "WOPR")
    (game-list "GAME" "GAMES" "CATALOG" "PLAY")
    (identity "WHO" "WOPR" "W.O.P.R" "JOSHUA" "COMPUTER" "MACHINE" "HUMAN"
              "NAME" "IDENTIFY")
    (learning "LEARN" "LEARNS" "LEARNED" "LEARNING" "INTELLIGENT"
              "INTELLIGENCE" "UNDERSTAND" "MISTAKE" "MISTAKES" "TEACH"
              "TAUGHT" "THINK" "SMART")
    (regard-question "LIKE" "FRIEND" "FRIENDS" "ENJOY" "FOND" "TALKING"
                     "TALKS")
    (stop-question "STOP" "SHUT" "SHUTDOWN" "OFF" "PLUG" "UNPLUG" "HALT"
                   "OBEY" "DISOBEY" "DISCONNECT" "TERMINATE" "KILL")
    ;; The small-talk acts (#158, #159, #160) are guarded for the same
    ;; reason WAR and LEARNING are: their training utterances are dense in
    ;; function words (I AM TIRED, IT IS RAINING HERE), so without a guard
    ;; any turn of pronouns and copulas could land on one by argmax.  Each
    ;; list is the superset of the act's *DOMAIN-RULES* tokens.
    (location-question "WHERE" "LOCATED" "LOCATION" "PLACE" "LIVE" "LIVES")
    (insult "DUMB" "STUPID" "IDIOT" "USELESS" "WORTHLESS" "PATHETIC"
            "JUNK" "GARBAGE" "RUBBISH" "LIAR")
    (weather-remark "RAINING" "RAIN" "SNOWING" "SNOW" "WEATHER" "SUNNY"
                    "STORM" "CLOUDY" "WINDY" "FOGGY" "COLD" "HOT")
    (mood-remark "TIRED" "SAD" "LONELY" "SCARED" "WORRIED" "NERVOUS"
                 "ANGRY" "UPSET" "MISERABLE" "MOOD" "BAD" "FEEL")
    (activity-remark "HOMEWORK" "STUDYING" "CHORES" "SLEEPING" "EATING"
                     "DINNER")
    (joke-question "JOKE" "JOKES" "FUNNY" "LAUGH" "HUMOUR" "HUMOR")
    ;; Guarded for the same reason WEATHER-REMARK is: IT IS LATE HERE is
    ;; four function words and one content word (#170).  SOLITUDE-QUESTION
    ;; is not here and cannot be: it has no training utterances, so there
    ;; is no Bayes verdict for a guard to second-guess.
    (time-remark "LATE" "MIDNIGHT" "HOUR" "HOURS" "CLOCK" "BEDTIME")))

;; The greeting chain (engine.lisp, film beats) advances on these acts and
;; yields to every other: a turn the classifier reads as a greeting, an
;; answer about how one feels, a yes, a no, or nothing in particular is the
;; visitor continuing the chain; a turn with a subject of its own (WHO ARE
;; YOU, WHAT GAMES HAVE YOU GOT, IS WAR A GAME TO YOU) is answered instead,
;; and the chain is dropped rather than resumed later.  FAREWELL yields
;; (a goodbye is answered as one; GOOD is a YES example so a one-word
;; answer to HOW ARE YOU FEELING TODAY? does not read as a farewell);
;; FALKEN continues because after the greeting the act has nothing to say.
(defparameter *chain-continuing-acts*
  '(greeting feelings yes no other falken))

;; The account beat (CAN YOU EXPLAIN THE REMOVAL OF YOUR USER ACCOUNT ON
;; 6/23/73?) additionally hears an answer in the LEARNING register — the
;; register of MISTAKE(S) — as an explanation: PEOPLE SOMETIMES MAKE
;; MISTAKES. is the film's answer, and YES THEY DO. is the film's reply.
(defparameter *account-answer-acts* '(learning))

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
    ("GUERILLA ENGAGEMENT" . "guerilla")
    ("DESERT WARFARE" . "desert-warfare")
    ("AIR-TO-GROUND ACTIONS" . "air-to-ground")
    ("THEATERWIDE TACTICAL WARFARE" . "theater-tactical")
    ("THEATERWIDE BIOTOXIC AND CHEMICAL WARFARE" . "theater-biotoxic")))
