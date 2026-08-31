#!/usr/bin/env bash
# Check the three structural invariants of the act-guard/domain-rule split
# (#157). These are facts about the tables in src/corpus.lisp, not about any
# one turn, so they are asserted here rather than pinned in a golden fixture:
#
#   1. No *ACT-GUARDS* token is a *STOP-WORDS* entry. A guard token that is a
#      function word cannot discriminate — it is in nearly every turn, so the
#      guard admits nearly every turn. IDENTITY listed YOU until #157.
#   2. No guarded act rejects its own training data: every *ACT-EXAMPLES*
#      utterance of a guarded act that no *DOMAIN-RULES* entry routes carries
#      one of that act's guard tokens. The control against the opposite
#      failure — a guard tightened until it turns away the turns it was
#      trained on (the reject-everything regression #155 guards against).
#   3. No domain rule consults the Bayes verdict: every clause is :ANY or
#      :ALL. A rule that also tested the raw act would be a guard wearing a
#      rule's clothes, and — running first — would shadow the real guard.
#      That is exactly how the IDENTITY guard became unreachable.
#
# Run from harness/build.sh, so `make build` (and therefore CI's `make test`)
# fails on a corpus edit that breaks any of them. Requires SBCL.
set -euo pipefail
cd "$(dirname "$0")"
command -v sbcl >/dev/null 2>&1 || {
  echo "verify-act-guards: sbcl not found on PATH" >&2; exit 1; }

if ! sbcl --noinform --non-interactive \
     --load ../src/package.lisp \
     --load ../src/corpus.lisp \
     --load ../src/engine.lisp \
     --eval '
(let ((failures 0))
  (labels ((fail (fmt &rest args)
             (incf failures)
             (format *error-output* "FAIL verify-act-guards: ")
             (apply (function format) *error-output* fmt args)
             (terpri *error-output*)))
    ;; 1. guards hold content tokens only.
    (dolist (guard joshua::*act-guards*)
      (dolist (token (cdr guard))
        (when (member token joshua::*stop-words* :test (function string=))
          (fail "guard ~a lists ~s, a *STOP-WORDS* entry. A function word is ~
in nearly every turn, so the guard admits nearly every turn."
                (car guard) token))))
    ;; 2. no guarded act rejects its own training data.
    (dolist (guard joshua::*act-guards*)
      (let* ((act (car guard))
             (examples (cdr (assoc act joshua::*act-examples*))))
        (when (null examples)
          (fail "guard ~a guards an act with no *ACT-EXAMPLES* entry." act))
        (dolist (example examples)
          (let ((tokens (joshua::tokenize example)))
            (when (and (null (joshua::rule-domain-act tokens))
                       (not (eq (joshua::guarded-act tokens act) act)))
              (fail "guard ~a turns away its own training example ~s: no ~
domain rule routes it and it carries none of the guard tokens."
                    act example))))))
    ;; 3. rules read the turn and nothing else.
    (dolist (rule joshua::*domain-rules*)
      (dolist (clause (cdr rule))
        (unless (member (car clause) (list :any :all))
          (fail "domain rule ~a has a ~a clause. A rule that consults the ~
Bayes verdict shadows the guard for the same act (#157)."
                (car rule) (car clause))))))
  (if (> failures 0)
      (sb-ext:exit :code 1)
      (format t "verify-act-guards: OK (~a guards, no stop-word tokens, none ~
turns away its own training data; ~a domain rules, all reading the turn ~
alone)~%"
              (length joshua::*act-guards*) (length joshua::*domain-rules*))))'
then
  echo "verify-act-guards: FAILED (see the FAIL lines above)" >&2
  exit 1
fi
