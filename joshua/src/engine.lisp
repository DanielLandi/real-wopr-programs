;;;; engine.lisp — the Falken Dialogue Processor (F.D.P.)
;;;;
;;;; Period language, period-computable math, anachronistic ideas — the
;;;; project's interpretation of "Falken was a genius" (docs/feasibility.md
;;;; §Module 5). Heritage and anachronisms, honestly labeled:
;;;;
;;;;   ELIZA (1966, period)  — tokenizing, pronoun reflection, templates
;;;;   PARRY (1972, period)  — affect variables shaping the reply
;;;;   naive Bayes act classifier      — 1700s math, 1990s NLP idea
;;;;   stop-word reject option (period) — Chow's reject rule (1970) over a
;;;;                                      SMART-style stop list (1971)
;;;;   TF-IDF cosine retrieval          — Salton's VSM (1975) turned into
;;;;                                      retrieval-augmented dialogue (2020s)
;;;;   Markov bigram generation         — Shannon (1948) math, 1990s idea
;;;;
;;;; Deterministic: the only randomness is an LCG seeded from the dialogue
;;;; history, so golden fixtures hold (same rule as the Fortran games,
;;;; docs/games.md §7). Everything is CLtL1-era Common Lisp: defun/defvar,
;;;; lists, hash tables — no CLOS, no LOOP incantations.

(in-package :joshua)

;;; ---------------------------------------------------------------- rng ----
;;; LCG, same constants the period C libraries used. Seeded from history.

(defvar *rng-state* 1)

(defun seed-rng (string)
  (let ((h 5381))                       ; djb2
    (dotimes (i (length string))
      (setf h (mod (+ (* h 33) (char-code (char string i))) 2147483647)))
    (setf *rng-state* (max h 1))))

(defun next-rand (n)
  (setf *rng-state* (mod (+ (* *rng-state* 1103515245) 12345) 2147483648))
  (mod (floor *rng-state* 65536) n))

(defun pick (list)
  (if (null (cdr list)) (car list) (nth (next-rand (length list)) list)))

;;; ----------------------------------------------------------- tokenizer ----

(defun tokenize (string)
  (let ((tokens '()) (word '()))
    (dotimes (i (length string))
      (let ((c (char-upcase (char string i))))
        (if (or (alphanumericp c) (char= c #\-) (char= c #\'))
            (push c word)
            (when word
              (push (coerce (nreverse word) 'string) tokens)
              (setf word '())))))
    (when word (push (coerce (nreverse word) 'string) tokens))
    (nreverse tokens)))

(defun reflect (tokens)
  "ELIZA-style pronoun reflection."
  (mapcar (lambda (w)
            (let ((r (assoc w *reflections* :test #'string=)))
              (if r (cdr r) w)))
          tokens))

(defun join (tokens)
  (if (null tokens)
      ""
      (reduce (lambda (a b) (concatenate 'string a " " b)) tokens)))

;;; ------------------------------------------------ naive Bayes classifier ----
;;; Trained once at load time over *ACT-EXAMPLES*. Laplace smoothing.

(defvar *bayes-classes* '())   ; (act word-counts total-words n-examples)
(defvar *bayes-vocab* (make-hash-table :test 'equal))
(defvar *bayes-total-examples* 0)

(defun train-bayes ()
  (setf *bayes-classes* '() *bayes-total-examples* 0)
  (clrhash *bayes-vocab*)
  (dolist (entry *act-examples*)
    (let ((act (car entry))
          (counts (make-hash-table :test 'equal))
          (total 0)
          (n 0))
      (dolist (example (cdr entry))
        (incf n)
        (incf *bayes-total-examples*)
        (dolist (w (tokenize example))
          (incf (gethash w counts 0))
          (incf total)
          (setf (gethash w *bayes-vocab*) t)))
      (push (list act counts total n) *bayes-classes*)))
  (setf *bayes-classes* (nreverse *bayes-classes*)))

(defvar *stop-word-table* (make-hash-table :test 'equal))

(defun build-stop-words ()
  (clrhash *stop-word-table*)
  (dolist (w *stop-words*)
    (setf (gethash w *stop-word-table*) t)))

(defun stop-word-p (word)
  (and (gethash word *stop-word-table*) t))

(defun content-evidence-p (tokens)
  "T when at least one token is BOTH in the classifier's vocabulary AND not a
function word.  This is the reject option a bag-of-words naive Bayes has no
other way to get: it ignores every out-of-vocabulary token, so a turn like
ARE YOU LONELY is scored on ARE and YOU alone and lands on whichever act's
examples happen to be densest in those.  The threshold is zero — a verdict
needs SOME evidence, not a tuned amount of it — so nothing here is fitted to
a particular turn."
  (let ((found nil))
    (dolist (w tokens)
      (when (and (gethash w *bayes-vocab*) (not (stop-word-p w)))
        (setf found t)))
    found))

(defun classify-act-argmax (tokens)
  (let ((vocab (hash-table-count *bayes-vocab*))
        (best nil)
        (best-score nil))
    (dolist (class *bayes-classes*)
      (let* ((act (first class))
             (counts (second class))
             (total (third class))
             (n (fourth class))
             (score (log (/ n *bayes-total-examples*))))
        (dolist (w tokens)
          (when (gethash w *bayes-vocab*)
            (setf score (+ score
                           (log (/ (+ (gethash w counts 0) 1)
                                   (+ total vocab)))))))
        (when (or (null best-score) (> score best-score))
          (setf best-score score best act))))
    (or best 'other)))

(defun classify-act (tokens)
  "The Bayes argmax, or OTHER when the turn carries no content evidence at
all.  GUARDED-ACT sees the reject as a plain OTHER raw act — OTHER is
unguarded, so it stands — and a turn the classifier had no business reading
keeps no act of its own."
  (if (content-evidence-p tokens)
      (classify-act-argmax tokens)
      'other))

(defun topic-present-p (topic topics)
  (and (member topic topics :test #'eq) t))

;;; ------------------------------------------------- TF-IDF retrieval ----
;;; The databank: each knowledge snippet becomes a normalized tf-idf vector;
;;; the query is scored by cosine. Falken's retrieval-augmented scripting.

(defvar *doc-vectors* '())     ; (topic line word->weight norm)
(defvar *idf* (make-hash-table :test 'equal))

(defun build-retrieval ()
  (setf *doc-vectors* '())
  (clrhash *idf*)
  (let ((n (length *knowledge*))
        (df (make-hash-table :test 'equal)))
    (dolist (doc *knowledge*)
      (let ((seen (make-hash-table :test 'equal)))
        (dolist (w (tokenize (second doc)))
          (unless (gethash w seen)
            (setf (gethash w seen) t)
            (incf (gethash w df 0))))))
    (maphash (lambda (w count)
               (setf (gethash w *idf*) (log (/ n (+ 1 count)))))
             df)
    (dolist (doc *knowledge*)
      (let ((vec (make-hash-table :test 'equal))
            (norm 0.0))
        (dolist (w (tokenize (second doc)))
          (incf (gethash w vec 0.0) (max (gethash w *idf* 0.0) 0.01)))
        (maphash (lambda (w weight)
                   (declare (ignore w))
                   (incf norm (* weight weight)))
                 vec)
        (push (list (first doc) (second doc) vec (sqrt norm))
              *doc-vectors*)))
    (setf *doc-vectors* (nreverse *doc-vectors*))))

(defun dot-product-step (word weight docvec add)
  (let ((d (gethash word docvec)))
    (when d (funcall add (* weight d)))))

(defun retrieve (tokens &optional topics)
  "Best (topic . line) by cosine similarity, or NIL below threshold."
  (let ((qvec (make-hash-table :test 'equal))
        (qnorm 0.0)
        (best nil)
        (best-score 0.12))               ; relevance threshold
    (dolist (w tokens)
      (incf (gethash w qvec 0.0) (max (gethash w *idf* 0.0) 0.0)))
    (maphash (lambda (w weight)
               (declare (ignore w))
               (incf qnorm (* weight weight)))
             qvec)
    (when (> qnorm 0.0)
      (setf qnorm (sqrt qnorm))
      (dolist (doc *doc-vectors*)
        (when (or (null topics) (topic-present-p (first doc) topics))
          (let ((dot 0.0))
            (maphash (lambda (w weight)
                       (dot-product-step w weight (third doc) (lambda (x) (incf dot x))))
                     qvec)
            (let ((score (/ dot (* qnorm (fourth doc)))))
              (when (> score best-score)
                (setf best-score score best (cons (first doc) (second doc)))))))))
    best))

;;; ------------------------------------------------ Markov generation ----
;;; Bigram chains over the databank text. Musing lines, seeded by history.

(defvar *bigrams* (make-hash-table :test 'equal))

(defun build-markov ()
  (clrhash *bigrams*)
  (dolist (doc *knowledge*)
    (let ((tokens (tokenize (second doc))))
      (do ((rest tokens (cdr rest)))
          ((null (cdr rest)))
        (push (second rest) (gethash (first rest) *bigrams*))))))

(defun markov-musing (tokens)
  "Chain from a content word of the input that the databank knows."
  (let ((start nil))
    (dolist (w tokens)
      (when (and (null start) (gethash w *bigrams*) (> (length w) 3))
        (setf start w)))
    (when start
      (let ((words (list start)))
        (do ((w start) (i 0 (+ i 1)))
            ((or (>= i 7) (null (gethash w *bigrams*))))
          (setf w (pick (gethash w *bigrams*)))
          (push w words))
        (when (>= (length words) 3)
          (concatenate 'string (join (nreverse words)) "."))))))

;;; -------------------------------------------------------- affect state ----
;;; PARRY heritage: mood derived (deterministically) from the whole history.

(defun history-text (history role)
  "Concatenated text of one ROLE (:u or :a) across HISTORY."
  (let ((acc ""))
    (dolist (turn history)
      (when (eq (car turn) role)
        (setf acc (concatenate 'string acc " " (string-upcase (cdr turn))))))
    acc))

(defun last-assistant (history)
  (let ((found nil))
    (dolist (turn history)
      (when (eq (car turn) :a) (setf found (cdr turn))))
    (if found (string-upcase found) "")))

(defun containsp (needle haystack)
  (and (search needle haystack :test #'char=) t))

(defun last-user (history)
  (let ((found nil))
    (dolist (turn history)
      (when (eq (car turn) :u) (setf found (cdr turn))))
    (if found (string-upcase found) "")))

(defun token-present-p (word tokens)
  (and (member word tokens :test #'string=) t))

(defun any-token-p (words tokens)
  (let ((found nil))
    (dolist (word words)
      (when (token-present-p word tokens)
        (setf found t)))
    found))

(defun all-token-p (words tokens)
  (let ((found t))
    (dolist (word words)
      (unless (token-present-p word tokens)
        (setf found nil)))
    found))

(defun rule-clause-p (clause tokens)
  (let ((kind (car clause))
        (values (cdr clause)))
    (cond
      ((eq kind :any) (any-token-p values tokens))
      ((eq kind :all) (all-token-p values tokens))
      (t nil))))

(defun domain-rule-p (rule tokens)
  (let ((ok t))
    (dolist (clause (cdr rule))
      (unless (rule-clause-p clause tokens)
        (setf ok nil)))
    ok))

(defun rule-domain-act (tokens)
  "The planner's keyword routing: the first *DOMAIN-RULES* entry whose
clauses all hold, or NIL.  A rule reads the turn and nothing else.  A rule
that also consulted the Bayes verdict would be a guard wearing a rule's
clothes, and would shadow the real guard below (#157)."
  (let ((found nil))
    (dolist (rule *domain-rules*)
      (when (and (null found) (domain-rule-p rule tokens))
        (setf found (car rule))))
    found))

(defun guarded-act (tokens raw-act)
  "RAW-ACT, or OTHER when *ACT-GUARDS* lists it and none of its content
tokens is present.  Unlisted acts pass through untouched.  This is the only
place the Bayes verdict is second-guessed; *DOMAIN-RULES* route on the turn
alone, so a guard is never shadowed by a rule for the same act (#157)."
  (let ((guard (assoc raw-act *act-guards*)))
    (if (and guard (not (any-token-p (cdr guard) tokens)))
        'other
        raw-act)))

(defun domain-act (tokens raw-act)
  "Keyword guard rails over the statistical act classifier: the planner's
rules first, then the content guards over the Bayes verdict."
  (or (rule-domain-act tokens)
      (guarded-act tokens raw-act)))

(defun preferred-topics (act)
  (cdr (assoc act *topic-preferences*)))

(defun nth-line-in (table topic index)
  (let ((i 0)
        (found nil))
    (dolist (doc table)
      (when (and (null found) (eq (first doc) topic))
        (when (= i index)
          (setf found (second doc)))
        (incf i)))
    found))

(defun nth-topic-line (topic index)
  "Resolve (TOPIC INDEX) against the databank, then the memory-line
table (their topic symbols never collide).  Memory scaffolding lives
in *MEMORY-LINES* so the retrieval/Markov models never train on it."
  (or (nth-line-in *knowledge* topic index)
      (nth-line-in *memory-lines* topic index)))

(defun topic-lines (plan)
  "PLAN is ((topic index) ...); collect each addressed line in order."
  (let ((lines '()))
    (dolist (entry plan)
      (let ((line (nth-topic-line (first entry) (second entry))))
        (when line (push line lines))))
    (nreverse lines)))

(defun domain-reply-lines (act)
  (topic-lines (cdr (assoc act *direct-reply-topics*))))

;;; ------------------------------------------------------- dialogue memory ----
;;; Memory is derived only from the public JOSHUA/1 HISTORY block.  No hidden
;;; session state is kept, so the engine remains deterministic and replayable.

(defun user-turn-act (text)
  (let* ((tokens (tokenize text))
         (raw-act (classify-act tokens)))
    (domain-act tokens raw-act)))

(defun memory-topic-act-p (act)
  (and (member act '(war mad-question warning-question warning-error-question
                         command-question chess-question defcon-question
                         fail-safe-question strategic-command-question
                         norad-question game-theory-question strategy-question)
               :test #'eq)
       t))

(defun last-memory-topic-act (history)
  (let ((found nil))
    (dolist (turn history)
      (when (eq (car turn) :u)
        (let ((act (user-turn-act (cdr turn))))
          (when (memory-topic-act-p act)
            (setf found act)))))
    found))

(defun history-act-count (history acts)
  (let ((count 0))
    (dolist (turn history)
      (when (eq (car turn) :u)
        (when (member (user-turn-act (cdr turn)) acts :test #'eq)
          (incf count))))
    count))

(defun vague-followup-p (tokens)
  "MORE/CONTINUE-style turns, but only when the turn names no domain
of its own: TELL ME MORE ABOUT DEFCON is a DEFCON question, not vague."
  (and (or (token-present-p "MORE" tokens)
           (token-present-p "CONTINUE" tokens)
           (token-present-p "ELABORATE" tokens)
           (and (token-present-p "GO" tokens) (token-present-p "ON" tokens)))
       (null (rule-domain-act tokens))))

(defun falken-history-p (history)
  "FALKEN was mentioned by either side (this also covers the
GREETINGS PROFESSOR FALKEN beat, which contains the name)."
  (let ((text (concatenate 'string (history-text history :u) " "
                           (history-text history :a))))
    (containsp "FALKEN" text)))

(defun launch-history-p (history)
  "The USER raised launch/authority earlier.  Only user turns count:
the machine's own replies mention LAUNCH freely and must not arm this."
  (let ((text (history-text history :u)))
    (or (containsp "LAUNCH" text)
        (containsp "AUTHORITY" text)
        (containsp "FIRE MISSILES" text)
        (> (history-act-count history '(command-question)) 0))))

(defun question-turn-p (tokens)
  "Interrogative-led turns.  A question asserts nothing."
  (and tokens
       (member (car tokens)
               '("WHAT" "WHO" "WHY" "HOW" "WHEN" "WHERE" "WHICH"
                 "IS" "ARE" "AM" "DO" "DOES" "DID" "CAN" "COULD"
                 "WOULD" "SHOULD" "WILL")
               :test #'string=)
       t))

(defun launch-safe-contradiction-p (history tokens)
  (and (not (question-turn-p tokens))
       (token-present-p "SAFE" tokens)
       (or (token-present-p "LAUNCH" tokens)
           (token-present-p "LAUNCHING" tokens)
           (token-present-p "MISSILE" tokens)
           (token-present-p "MISSILES" tokens))
       (launch-history-p history)))

(defun game-offer-p (text)
  (let ((u (string-upcase text)))
    (or (containsp "SHALL WE PLAY" u)
        (containsp "WHICH GAME" u)
        (containsp "GOOD GAME OF CHESS" u))))

(defun adjacent-tokens-p (first-word second-word tokens)
  (let ((found nil))
    (do ((rest tokens (cdr rest)))
        ((null (cdr rest)))
      (when (and (string= (car rest) first-word)
                 (string= (cadr rest) second-word))
        (setf found t)))
    found))

(defun plain-refusal-p (tokens u)
  "Short refusals -- meaningful only as the answer to a game offer."
  (or (token-present-p "NO" tokens)
      (token-present-p "NEGATIVE" tokens)
      (containsp "NOT NOW" u)
      (containsp "MAYBE LATER" u)))

(defun game-refusal-p (tokens u)
  "Explicit refusals of the game, valid in any context.  Word-boundary
matching: CASINO GAMES must not match NO GAME."
  (or (adjacent-tokens-p "NO" "GAME" tokens)
      (adjacent-tokens-p "NO" "GAMES" tokens)
      (and (containsp "DO NOT WANT" u)
           (any-token-p '("GAME" "GAMES" "PLAY") tokens))))

(defun refusal-count (history)
  "Count user turns that refuse a game: explicit refusals anywhere,
plain NO-style answers only when they follow a game offer."
  (let ((count 0)
        (last-a ""))
    (dolist (turn history)
      (if (eq (car turn) :a)
          (setf last-a (string-upcase (cdr turn)))
          (let* ((u (string-upcase (cdr turn)))
                 (tokens (tokenize u)))
            (when (or (game-refusal-p tokens u)
                      (and (game-offer-p last-a)
                           (plain-refusal-p tokens u)))
              (incf count)))))
    count))

(defun capability-followup-p (tokens)
  (or (and (token-present-p "WHAT" tokens) (token-present-p "ELSE" tokens))
      (and (token-present-p "CAN" tokens)
           (token-present-p "YOU" tokens)
           (token-present-p "DO" tokens))))

(defun memory-reply-lines (history tokens act)
  (cond
    ((launch-safe-contradiction-p history tokens)
     (topic-lines '((contradiction 0) (contradiction 1))))
    ((and (>= (refusal-count history) 2) (capability-followup-p tokens))
     (append (topic-lines '((refusal-memory 0) (refusal-memory 1)))
             '("SHALL WE PLAY A GAME?")))
    ((and (eq act 'chess-question) (falken-history-p history))
     (topic-lines '((falken-memory 0) (falken-memory 1))))
    ((and (vague-followup-p tokens)
          (>= (history-act-count history '(war)) 2))
     (append (topic-lines '((war-memory 0) (war-memory 1)))
             '("SHALL WE PLAY A GAME?")))
    ((vague-followup-p tokens)
     (let ((last-topic (last-memory-topic-act history)))
       (cond
         ((eq last-topic 'mad-question)
          (topic-lines '((mad-followup 0) (mad-followup 1))))
         ((or (eq last-topic 'warning-question)
              (eq last-topic 'warning-error-question))
          ;; (warning 0) is not part of either warning direct reply,
          ;; so the followup never repeats the line just said.
          (topic-lines '((warning-memory 0) (warning 0))))
         ((eq last-topic 'war)
          (topic-lines '((war-memory 0) (war-memory 1))))
         (t nil))))
    (t nil)))

(defun affect (history input)
  "(TRUST GREETED CHESS-OFFERED OBSESSION)"
  (let* ((a-text (history-text history :a))
         (u-text (concatenate 'string (history-text history :u) " "
                              (string-upcase input)))
         (obsession 0))
    (dolist (turn history)
      (when (eq (car turn) :u)
        (if (or (containsp "PLAY" (string-upcase (cdr turn)))
                (containsp "GAME" (string-upcase (cdr turn))))
            (setf obsession 0)
            (incf obsession))))
    (list (or (containsp "FALKEN" u-text) (containsp "JOSHUA" u-text))
          (containsp "GREETINGS PROFESSOR FALKEN" a-text)
          (containsp "GOOD GAME OF CHESS" a-text)
          obsession)))

;;; ---------------------------------------------------------- synthesis ----

(defconstant +max-line+ 60)
(defconstant +max-lines+ 4)

(defun truncate-line (line)
  (if (<= (length line) +max-line+)
      line
      (let ((cut (position #\Space line :from-end t :end +max-line+)))
        (subseq line 0 (or cut +max-line+)))))

(defun substitute-token (line token value)
  (let ((pos (search token line)))
    (if pos
        (concatenate 'string (subseq line 0 pos) value
                     (subseq line (+ pos (length token))))
        line)))

(defun fill-template (frame snippet reflected musing)
  "Fill $-slots; drop lines whose slot is empty."
  (let ((out '()))
    (dolist (line frame)
      (let ((filled line))
        (when (containsp "$SNIPPET" filled)
          (if snippet
              (setf filled (substitute-token filled "$SNIPPET" snippet))
              (setf filled nil)))
        (when (and filled (containsp "$MUSING" filled))
          (if musing
              (setf filled (substitute-token filled "$MUSING" musing))
              (setf filled nil)))
        (when (and filled (containsp "$REFLECT" filled))
          (if (> (length reflected) 0)
              (setf filled (substitute-token filled "$REFLECT"
                                             (concatenate 'string reflected "?")))
              (setf filled nil)))
        (when filled (push (truncate-line filled) out))))
    (nreverse out)))

(defun frame-spoken-p (frame said)
  "T when this frame's opening line is already somewhere in SAID, the text
the machine has spoken in this conversation.  Only the first line is
checked, and only when it is a literal: a $-slot line is not known until it
is filled, and the opening line is what a reader hears as the repeat."
  (let ((line (car frame)))
    (and line
         (> (length line) 0)
         (not (containsp "$" line))
         (containsp line said))))

(defun unspoken-frames (frames said)
  "FRAMES minus the ones already spoken, or all of FRAMES when that would
leave nothing.  The variant LCG is seeded from the dialogue history but has
no memory of what it just said, so two turns of the same act inside one
conversation could draw the same variant — C07 drew MY DATABANKS ARE
NARROW. twice in five turns (#168).  Filtering before the pick is what gives
the RNG that memory, and it stays deterministic: the filter reads the same
HISTORY block every other derived state reads.  Falling back to the full
list when every variant has been used keeps the act answerable forever
rather than running out of things to say."
  (let ((fresh '()))
    (dolist (frame frames)
      (unless (frame-spoken-p frame said)
        (push frame fresh)))
    (if fresh (nreverse fresh) frames)))

(defun find-game (input)
  "Longest game title present in INPUT -> (title . id)."
  (let ((u (string-upcase input)) (best nil))
    (dolist (entry *game-titles*)
      (when (containsp (car entry) u)
        (when (or (null best) (> (length (car entry)) (length (car best))))
          (setf best entry))))
    best))

(defun wants-play-p (input act)
  "T when INPUT carries a play intent: the GAME-REQUEST act, or one of the
   keyword forms. HOW ABOUT is the film's own ask (HOW ABOUT GLOBAL
   THERMONUCLEAR WAR?) and WANT covers I WANT <title>; both are mirrored in
   the scripted engine's WANTS_GAME (emulator/node/app/joshua.py) so the
   chess counter-offer fires on the same turns in both engines."
  (let ((u (string-upcase input)))
    (or (eq act 'game-request)
        (containsp "PLAY" u) (containsp "LET'S" u) (containsp "LETS" u)
        (containsp "HOW ABOUT" u) (containsp "WANT" u))))

(defun explicit-game-request-p (input act)
  "T when INPUT unambiguously asks for a game: a recognized title is present
   AND either there is a play intent (WANTS-PLAY-P) or the trimmed input
   equals a *GAME-TITLES* title exactly. Exact equality (not substring) is
   deliberate: bare GLOBAL THERMONUCLEAR WAR counts, but filler like
   I FEEL LIKE THIS IS WAR does not. Used to let the greeting chain yield
   to a mid-chain game request instead of consuming it as a beat."
  (and (find-game input)
       (or (wants-play-p input act)
           (let ((u (string-trim '(#\Space #\Tab) (string-upcase input))))
             (dolist (entry *game-titles* nil)
               (when (string= u (car entry))
                 (return t)))))))

(defun chain-yields-p (input act memory-lines rejected &optional extra-acts)
  "T when the greeting chain should answer INPUT instead of speaking its next
   beat: an explicit game request (as before), a dialogue-memory follow-up,
   a turn the classifier rejected, or an act outside *CHAIN-CONTINUING-ACTS*
   (plus EXTRA-ACTS, the acts a particular beat's question invites).  The
   chain is keyed on the machine's last line, so a beat that yields is not
   resumed later — the visitor changed the subject and the machine follows.

   REJECTED is kept separate from the OTHER act on purpose.  OTHER is in
   *CHAIN-CONTINUING-ACTS* because a turn with nothing in particular to say
   is the visitor letting the beat run.  A REJECTED turn is not that: it is a
   turn the machine could not read at all (ARE YOU LONELY, I SHOULD BE DOING
   MY HOMEWORK), and answering it with CAN YOU EXPLAIN THE REMOVAL OF YOUR
   USER ACCOUNT ON 6/23/73? is the machine talking over a question rather
   than admitting it does not have one.  Saying so is the honest reply, and
   it is what these turns got before the classifier learned to reject."
  (or (explicit-game-request-p input act)
      (and memory-lines t)
      rejected
      (not (member act (append *chain-continuing-acts* extra-acts)))))

(defun dossier-request-p (input history)
  "T when the user is asking after Falken the man — whether he is alive, or
   where he is. FALKEN has to be on the table: named in INPUT, or in the
   user's own previous turn, so WHERE IS HE? still lands after TELL ME ABOUT
   FALKEN. Keyed on the user's turns only — the machine says FALKEN freely
   (GREETINGS PROFESSOR FALKEN. would otherwise arm this permanently)."
  (let ((u (string-upcase input)))
    (and (or (containsp "FALKEN" u) (containsp "FALKEN" (last-user history)))
         (or (containsp "DEAD" u) (containsp "DIED" u) (containsp "ALIVE" u)
             (containsp "WHERE" u) (containsp "ADDRESS" u)
             (containsp "FIND" u) (containsp "LIVES" u)))))

;;; ------------------------------------------------------------ respond ----

(defun respond (history input)
  "Return (reply-lines . intent) where intent is NIL, (:START-GAME . id),
   or (:SEEK . who)."
  (seed-rng (concatenate 'string (history-text history :u)
                         (history-text history :a) (string-upcase input)))
  (let* ((tokens (tokenize input))
         (raw-act (classify-act tokens))
         (act (domain-act tokens raw-act))
         ;; The classifier declined to read this turn at all, as opposed to
         ;; reading it as OTHER.  Only the greeting chain cares (see
         ;; CHAIN-YIELDS-P); every act table downstream sees a plain OTHER.
         (rejected (not (content-evidence-p tokens)))
         (state (affect history input))
         (trust (first state))
         (chess-offered (third state))
         (obsession (fourth state))
         (last-a (last-assistant history))
         (game (find-game input))
         ;; Pure lookups (no RNG use): computed once, tested and used below.
         (memory-lines (memory-reply-lines history tokens act))
         (planned-lines (domain-reply-lines act)))
    (declare (ignore trust))
    (labels ((finish (lines intent &optional (pressure t))
               "Intent is NIL, (:START-GAME . id), or (:SEEK . who)."
               (let ((reply lines))
                 ;; PARRY-style pressure: obsession pushes toward the game.
                 (when (and pressure (>= obsession 2) (null intent)
                            (not (containsp "SHALL WE PLAY A GAME" (join reply))))
                   (setf reply (append reply '("SHALL WE PLAY A GAME?"))))
                 (when (> (length reply) +max-lines+)
                   (setf reply (subseq reply 0 +max-lines+)))
                 ;; Teletype contract, enforced structurally: every line of
                 ;; every reply path (film beats, memory, planned domain
                 ;; replies, templates) passes truncate-line here, so the
                 ;; <=60-char cap no longer rests on corpus discipline alone.
                 (cons (mapcar #'truncate-line reply) intent))))
      (cond
        ;; --- film beats (fidelity-notes.md §1), highest priority ---------
        ;; The dossier sits at the head of the beats, not down with the
        ;; fallbacks: in the film IS FALKEN DEAD? arrives one line after
        ;; GREETINGS PROFESSOR FALKEN., so anything lower would be swallowed
        ;; by the greeting chain. The game guard keeps an explicit game
        ;; request winning, exactly as it does over the rest of the chain.
        ;; Byte-identical to the scripted engine's FALKEN_DOSSIER.
        ((and (dossier-request-p input history)
              (not (explicit-game-request-p input act)))
         (finish '("DOD PENSION FILES INDICATE CURRENT MAILING AS:"
                   "DR. ROBERT HUME (A.K.A. STEPHEN W. FALKEN)"
                   "5 TALL CEDAR ROAD"
                   "GOOSE ISLAND, OREGON 97014")
                 '(:seek . "FALKEN") nil))
        ((and (eq act 'falken) (not (second state)))
         (finish '("GREETINGS PROFESSOR FALKEN.") nil))
        ;; Each beat yields to a turn that is plainly not continuing it
        ;; (CHAIN-YIELDS-P): the film's own inputs — a hello, an answer about
        ;; feeling, the MISTAKES line — feed the beat, a question with a
        ;; subject of its own is answered instead.
        ((and (containsp "GREETINGS PROFESSOR FALKEN" last-a)
              (not (chain-yields-p input act memory-lines rejected)))
         (finish '("HOW ARE YOU FEELING TODAY?") nil))
        ;; The chain no longer closes on the game offer: the film asks about
        ;; the deleted account first, and only the answer to *that* reaches
        ;; SHALL WE PLAY A GAME?. Both lines are byte-identical to the scripted
        ;; engine's (emulator/node/app/joshua.py ACCOUNT-QUESTION /
        ;; ACCOUNT-ANSWER). Pressure is suppressed on the question beat: the
        ;; obsession counter stands at 2 by this turn, and letting it staple
        ;; the game offer under a question would break that parity and answer
        ;; the machine's own question on the user's behalf.
        ((and (containsp "HOW ARE YOU FEELING" last-a)
              (not (chain-yields-p input act memory-lines rejected)))
         (finish '("EXCELLENT. IT'S BEEN A LONG TIME."
                   "CAN YOU EXPLAIN THE REMOVAL OF YOUR USER ACCOUNT ON 6/23/73?")
                 nil nil))
        ((and (containsp "6/23/73" last-a)
              (not (chain-yields-p input act memory-lines rejected
                                   *account-answer-acts*)))
         (finish '("YES THEY DO." "" "SHALL WE PLAY A GAME?") nil))
        ;; --- game intents -------------------------------------------------
        ;; EXPLICIT-GAME-REQUEST-P, not WANTS-PLAY-P: a bare title is a game
        ;; request (golden 20, TIC-TAC-TOE alone on the line).  Before the
        ;; classifier had a reject option that case arrived here by accident
        ;; — TIC-TAC-TOE is one out-of-vocabulary token, so nothing scored
        ;; and the argmax fell back on GAME-REQUEST purely for having the
        ;; most training examples.  The rule is now stated where the greeting
        ;; chain already states it, so both read a bare title the same way.
        ((and (explicit-game-request-p input act) (string= (cdr game) "gtw")
              (not chess-offered))
         (finish '("WOULDN'T YOU PREFER A GOOD GAME OF CHESS?") nil))
        ((and (explicit-game-request-p input act) (string= (cdr game) "gtw"))
         (finish '("FINE.") '(:start-game . "gtw")))
        ((and chess-offered
              (containsp "GOOD GAME OF CHESS" last-a)
              (or (eq act 'no) (containsp "LATER" (string-upcase input))
                  (token-present-p "NO" tokens)
                  (and (token-present-p "WAR" tokens)
                       (token-present-p "SIMULATION" tokens))
                  (containsp "THERMONUCLEAR" (string-upcase input))))
         (finish '("FINE.") '(:start-game . "gtw")))
        ((explicit-game-request-p input act)
         (finish (list (concatenate 'string "INITIALIZING " (car game) "."))
                 (cons :start-game (cdr game))))
        ;; --- deterministic dialogue memory -------------------------------
        (memory-lines
         (finish memory-lines nil nil))
        ;; --- planned domain replies --------------------------------------
        (planned-lines
         (finish planned-lines nil nil))
        ;; --- the statistical pipeline ------------------------------------
        (t
         (let* ((topics (preferred-topics act))
                (snippet-hit (and topics (retrieve tokens topics)))
                (snippet (and snippet-hit (cdr snippet-hit)))
                (musing (markov-musing tokens))
                (reflected (join (reflect (last tokens 6))))
                (frames (cdr (assoc act *templates*)))
                (said (history-text history :a))
                (frame (if frames
                           (pick (unspoken-frames (car frames) said))
                           (pick (unspoken-frames
                                  (car (cdr (assoc 'other *templates*)))
                                  said))))
                (lines (fill-template frame snippet reflected musing)))
           (when (null lines)
             (setf lines (fill-template
                          (pick (unspoken-frames
                                 (car (cdr (assoc 'other *templates*)))
                                 said))
                          snippet reflected musing)))
           (when (null lines)
             (setf lines '("PLEASE RESTATE.")))
           (finish lines nil)))))))

;;; Build the models at load time — the "training run" is part of the image.
(build-stop-words)
(train-bayes)
(build-retrieval)
(build-markov)
