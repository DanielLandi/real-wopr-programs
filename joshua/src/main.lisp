;;;; main.lisp — JOSHUA/1 wire protocol (stdin -> stdout, then exit).
;;;;
;;;; Same execution model as the Fortran core (design.md §4): a stateless
;;;; subprocess the bridge spawns per exchange. Deterministic given the frame.
;;;;
;;;; Request:                          Response:
;;;;   JOSHUA/1 CHAT                     JOSHUA/1 OK
;;;;   HISTORY <n>                       REPLY <k>
;;;;   U <text>   (n lines, U/A)         <k lines of teletype text>
;;;;   A <text>                          INTENT START-GAME <id>   (optional)
;;;;   INPUT <text>                      INTENT SEEK <who>        (optional)
;;;;                                     END
;;;;   END
;;;;
;;;; One line more, and only when the binary was launched `--debug-act`:
;;;;
;;;;                                     DEBUG ACT <act> PATH <arm>
;;;;
;;;; It is a property of the launch, not of the protocol.  A re-pin round's
;;;; whole question is "changed act, or changed variant?", and answering it
;;;; by reading reply text back against corpus.lisp is what real-wopr#262 was
;;;; filed about; JOSHUA/1 itself stays the period frame it was, so the host
;;;; never sees this line unless a tool asked for it.  The parser on the other
;;;; side (LispJoshua in emulator/node/app/joshua.py) ignores trailer lines it
;;;; does not recognise, so an old host reading a --debug-act binary is not a
;;;; wire break either.

(in-package :joshua)

(define-condition bad-frame (error) ())

(defun read-frame-line ()
  (let ((line (read-line *standard-input* nil nil)))
    (unless line (error 'bad-frame))
    (string-right-trim '(#\Return #\Space) line)))

(defun expect-prefix (line prefix)
  (unless (and (>= (length line) (length prefix))
               (string= prefix line :end2 (length prefix)))
    (error 'bad-frame))
  (string-left-trim '(#\Space) (subseq line (length prefix))))

(defun read-request ()
  "Returns (history . input); history is a list of (:u|:a . text)."
  (expect-prefix (read-frame-line) "JOSHUA/1 CHAT")
  (let* ((n (parse-integer (expect-prefix (read-frame-line) "HISTORY")
                           :junk-allowed nil))
         (history '()))
    (dotimes (i n)
      (let ((line (read-frame-line)))
        (cond ((and (>= (length line) 2) (string= "U " line :end2 2))
               (push (cons :u (subseq line 2)) history))
              ((and (>= (length line) 2) (string= "A " line :end2 2))
               (push (cons :a (subseq line 2)) history))
              (t (error 'bad-frame)))))
    (let ((input (expect-prefix (read-frame-line) "INPUT")))
      (expect-prefix (read-frame-line) "END")
      (cons (nreverse history) input))))

(defun debug-act-requested-p ()
  "T when this process was launched with --debug-act.  SBCL-specific, which
is why it lives here: main.lisp is the only file allowed to know it is SBCL."
  (let ((found nil))
    (dolist (arg (cdr sb-ext:*posix-argv*))
      (when (string= arg "--debug-act") (setf found t)))
    found))

(defun debug-name (symbol)
  (string-downcase (symbol-name (or symbol 'none))))

(defun write-response (lines intent)
  (format t "JOSHUA/1 OK~%REPLY ~D~%" (length lines))
  (dolist (line lines) (format t "~A~%" line))
  (when intent
    (ecase (car intent)
      (:start-game (format t "INTENT START-GAME ~A~%" (cdr intent)))
      (:seek       (format t "INTENT SEEK ~A~%" (cdr intent)))))
  (when (debug-act-requested-p)
    (format t "DEBUG ACT ~A PATH ~A~%"
            (debug-name *chosen-act*) (debug-name *chosen-path*)))
  (format t "END~%")
  (finish-output))

(defun main ()
  (handler-case
      (let* ((request (read-request))
             (result (respond (car request) (cdr request))))
        (write-response (car result) (cdr result))
        (sb-ext:exit :code 0))
    (error ()
      (write-response '("PLEASE RESTATE.") nil)
      (sb-ext:exit :code 1))))
