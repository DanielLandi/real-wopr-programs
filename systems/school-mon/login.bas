10 REM SEATTLE PUBLIC SCHOOL DISTRICT - SYSTEM/1 school-mon
20 REM The monitor. Answers the district's dial-in line, authenticates
30 REM against ACCT.DAT, then either EXECs the account's captive program
40 REM or gives the caller `Ready` (docs/systems.md 2.6).
50 REM Stateless per invocation: PHASE, ACCT and TRIES ride the STATE
60 REM block, and so does the turn-counted batch spool (NEXTJOB, JOB,
65 REM STEP, PROG, REPORT) - no wall clock, no rng.
70 REM ACCT.DAT keys on the password, not the PPN: the film's terminal
80 REM asks for a password alone, and the film is authority. See
90 REM docs/fidelity-notes.md section 7.
100 DIM AP$(40)
105 DIM AW$(40)
110 DIM AV(40)
115 DIM AC(40)
120 DIM AG$(40)
121 DIM CN$(40)
122 DIM CO$(40)
123 DIM CB(40)
124 DIM CV(40)
125 GOSUB 8500
126 DIM CD$(40), CS$(40), CR$(40), CK$(40)
127 GOSUB 8600
128 GOSUB 8680
129 DIM RL$(12), JL$(12)
130 REM ---- parse the SYSTEM/1 request from stdin ----
135 LINE INPUT H$
140 IF LEFT$(H$, 20) <> "SYSTEM/1 school-mon " THEN GOTO 7000
145 CMD$ = MID$(H$, 21)
150 LINE INPUT S$
155 IF LEFT$(S$, 6) <> "STATE " THEN GOTO 7000
160 SN = VAL(MID$(S$, 7))
200 PH$ = "LOGIN"
205 AK$ = "-"
206 JN = 412
207 JQ = 0
208 JS = 0
209 JP$ = ""
210 TR = 0
211 JR$ = ""
212 RC = 0
215 IF SN <= 0 THEN GOTO 300
220 FOR I = 1 TO SN
225 LINE INPUT L$
230 GOSUB 6000
235 NEXT I
300 LINE INPUT T$
305 HI = 0
306 RS$ = "-"
307 NR = 0
308 IF LEFT$(T$, 6) = "REPLY " THEN GOTO 360
310 IF LEFT$(T$, 6) <> "INPUT " THEN GOTO 330
315 IN$ = MID$(T$, 7)
320 HI = 1
325 GOTO 340
330 IF T$ <> "END" THEN GOTO 7000
335 GOTO 400
340 LINE INPUT E$
345 IF E$ <> "END" THEN GOTO 7000
350 GOTO 400
360 REM ---- REPLY <peer> <status> <n>: the answer to last turn's CALL
361 REM (docs/systems.md 2.3), mirroring records.bas's 530 shape. login.bas
362 REM only ever issues one CALL (4900, the batch advance), so unlike
363 REM records.bas's ST$-keyed AWAITREC/AWAITSET split there is nothing to
364 REM branch on here - any REPLY reaching this program is that job's.
365 R9$ = MID$(T$, 7)
366 SP9 = INSTR(R9$, " ")
367 IF SP9 = 0 THEN GOTO 7000
368 R9$ = MID$(R9$, SP9 + 1)
369 SP9 = INSTR(R9$, " ")
370 IF SP9 = 0 THEN GOTO 7000
371 RS$ = LEFT$(R9$, SP9 - 1)
372 NR = VAL(MID$(R9$, SP9 + 1))
373 IF NR <= 0 THEN GOTO 380
374 IF NR > 12 THEN GOTO 7000
375 FOR K9 = 1 TO NR
376 LINE INPUT RX$
377 RL$(K9) = RX$
378 NEXT K9
380 LINE INPUT E$
381 IF E$ <> "END" THEN GOTO 7000
400 REM ---- dispatch ----
405 IF CMD$ = "CONNECT" THEN GOTO 3000
410 IF CMD$ = "INPUT" THEN GOTO 3300
415 IF CMD$ = "RETURN" THEN GOTO 3800
417 IF CMD$ = "RESUME" THEN GOTO 3700
420 GOTO 7000
3000 REM CONNECT: the film's banner and password prompt
3010 PRINT "SYSTEM/1 school-mon OK"
3020 GOSUB 7500
3030 PRINT "DISPLAY 4"
3040 PRINT "PDP 11/270 PRB TIP #45"
3050 PRINT "TTY 34/984"
3060 PRINT ""
3070 PRINT "WELCOME TO THE SEATTLE PUBLIC SCHOOL DISTRICT DATANET"
3080 PRINT "PROMPT PLEASE LOGON WITH USER PASSWORD:"
3090 PRINT "LINE UP"
3095 PRINT "END"
3099 END
3300 REM INPUT
3305 IF HI = 0 THEN GOTO 7000
3310 IF PH$ = "READY" THEN GOTO 4000
3315 REM unauthenticated: the line is a password attempt
3320 GOSUB 8700
3325 IF AF = 0 THEN GOTO 3500
3330 AK$ = AP$(AF)
3335 TR = 0
3340 IF AC(AF) = 0 THEN GOTO 3400
3341 REM a captive account whose program did not resolve (8680) gets no
3342 REM EXEC at all — 3390 refuses out loud instead of handing the host
3343 REM an empty EXEC target to choke on.
3344 IF AG$(AF) = "-" OR AG$(AF) = "" THEN GOTO 3390
3345 REM captive: hand the terminal to the account's program
3350 PH$ = "EXEC"
3355 PRINT "SYSTEM/1 school-mon OK"
3360 GOSUB 7500
3365 PRINT "DISPLAY 0"
3370 PRINT "EXEC " + AG$(AF)
3375 PRINT "LINE UP"
3380 PRINT "END"
3385 END
3390 REM ---- captive account, but its program will not resolve: an
3391 REM honest 1983 misconfiguration, not a crash. No EXEC, no Ready —
3392 REM a captive account has nothing to fall back to.
3393 PRINT "SYSTEM/1 school-mon OK"
3394 GOSUB 7500
3395 PRINT "DISPLAY 1"
3396 PRINT "PROGRAM UNAVAILABLE - CALL PLANT SERVICE"
3397 PRINT "LINE DROP"
3398 PRINT "END"
3399 END
3400 REM non-captive: give the caller the monitor
3405 PH$ = "READY"
3410 PRINT "SYSTEM/1 school-mon OK"
3415 GOSUB 7500
3420 PRINT "DISPLAY 2"
3425 PRINT "RSTS V7.0-07  JOB 12  " + AK$ + "  KB34"
3426 REM ---- 3434 is 67 columns wide, and stays that way by decision (#58):
3427 REM the <=60 teletype contract binds what JOSHUA says, is enforced on
3428 REM that one path (emulator/node/app/joshua.py MAX_COLS) and is scoped
3429 REM to it in AGENTS.md. An RSTS/E system printing to a terminal that
3430 REM wrapped at 72-80 is not bound by it. Every other line in every
3431 REM system does sit under 60, so this one reads like an overrun; it is
3432 REM not. Split it only if that contract is deliberately widened to
3433 REM cover the systems tier - not on sight.
3434 PRINT "CAT, TYPE <FILE>, RUN <FILE>, SUBMIT <JOB>, QUEUE, PRINT <JOB>, BYE"
3435 PRINT "PROMPT Ready"
3440 PRINT "LINE UP"
3445 PRINT "END"
3450 END
3500 REM wrong password
3505 TR = TR + 1
3510 IF TR >= 3 THEN GOTO 3600
3515 PRINT "SYSTEM/1 school-mon OK"
3520 GOSUB 7500
3525 PRINT "DISPLAY 1"
3530 PRINT "INVALID PASSWORD"
3535 PRINT "PROMPT PLEASE LOGON WITH USER PASSWORD:"
3540 PRINT "LINE UP"
3545 PRINT "END"
3550 END
3600 REM three strikes
3605 PRINT "SYSTEM/1 school-mon OK"
3610 GOSUB 7500
3615 PRINT "DISPLAY 2"
3617 PRINT "INVALID PASSWORD"
3620 PRINT "ACCESS DENIED - TERMINAL LOCKED OUT"
3625 PRINT "LINE DROP"
3630 PRINT "END"
3635 END
3800 REM RETURN: the exec'd program finished. Where the caller lands depends
3802 REM on the account, not on the program: a captive account has no command
3804 REM surface to return to, so its program finishing ends the call. Only a
3806 REM non-captive account sees `Ready`.
3808 GOSUB 8950
3810 IF CP = 0 THEN GOTO 3820
3812 PRINT "SYSTEM/1 school-mon OK"
3814 GOSUB 7500
3816 PRINT "DISPLAY 0"
3817 PRINT "LINE DROP"
3818 PRINT "END"
3819 END
3820 PH$ = "READY"
3822 GOTO 3410
3700 REM ---- RESUME: school-ada has answered the CALL 4900 made last turn.
3701 REM RS$/NR/RL$ came off the REPLY at 360-381. A FAIL or TIMEOUT
3702 REM (systems.md 2.3: a subsystem being down is an ordinary Tuesday,
3703 REM not a hang) leaves the job RUNNING rather than losing it - the
3704 REM next turn's 4900 simply tries the CALL again.
3705 REM ---- forged-state guard (review Finding 5): every other dispatch
3706 REM target checks the session actually is what it claims before
3707 REM acting on it - INPUT checks HI (3305), RETURN checks the
3708 REM account's captive flag (3808). RESUME checked only RS$/NR: a
3709 REM forged JOB 0 or PHASE LOGIN reached the DONE branch below and
3710 REM could hand a Ready prompt to a session that was never
3711 REM authenticated. Refuse anything that is not genuinely a RUNNING
3712 REM job in an authenticated Ready session.
3713 IF PH$ <> "READY" THEN GOTO 7000
3714 IF JQ = 0 OR JS <> 1 THEN GOTO 7000
3715 IF RS$ <> "OK" THEN GOTO 3760
3716 IF NR <= 0 THEN GOTO 3760
3717 REM JR$ rides STATE as a "|"-separated string (task 3). A reply line
3718 REM that itself contained "|" would desync PRINT's split (task 5)
3719 REM silently, so refuse loudly instead of corrupting it - no field
3720 REM school-ada emits can produce one today (main.bas's field notes).
3721 FOR K9 = 1 TO NR
3722 IF INSTR(RL$(K9), "|") > 0 THEN GOTO 7000
3723 NEXT K9
3724 JR$ = RL$(1)
3725 IF NR = 1 THEN GOTO 3740
3726 FOR K9 = 2 TO NR
3727 JR$ = JR$ + "|" + RL$(K9)
3728 NEXT K9
3740 JS = 2
3742 PRINT "SYSTEM/1 school-mon OK"
3744 GOSUB 7500
3746 PRINT "DISPLAY 1"
3748 PRINT "JOB " + MID$(STR$(JQ), 2) + " " + JP$ + " DONE"
3750 GOSUB 7900
3752 END
3760 REM the peer did not answer, or answered with no lines (school-ada
3761 REM never does - see main.bas - but an empty reply is otherwise
3762 REM indistinguishable from "not run yet", so treat it the same way
3763 REM rather than guess). JS stays RUNNING; 4900 retries next turn.
3764 PRINT "SYSTEM/1 school-mon OK"
3766 GOSUB 7500
3768 PRINT "DISPLAY 1"
3770 PRINT "JOB " + MID$(STR$(JQ), 2) + " " + JP$ + " FAILED - RETRY"
3772 GOSUB 7900
3774 END
4000 REM ---- Ready: the monitor's own command surface ----
4001 REM MV = privilege of the account this session logged in as. The
4002 REM PPN does come out of STATE (6020); the privilege never does -
4003 REM 8900 looks it up in ACCT.DAT, so STATE can name an account but
4004 REM cannot carry what that account may do.
4005 GOSUB 8900
4006 REM ---- advance the batch spool one step per turn taken. Turn-
4007 REM counted, not clocked (systems.md 2.5): any command advances it,
4008 REM which is what makes the fixtures byte-exact. QUEUED -> RUNNING
4009 REM is a silent counter flip, alongside whatever the caller typed.
4010 REM RUNNING -> DONE needs the bus CALL at 4900, which occupies the
4011 REM whole turn per systems.md 2.3 - a job finishing preempts
4012 REM whatever the caller typed that turn, the same shape
4013 REM records.bas's own CALL sites take.
4014 IF JQ = 0 THEN GOTO 4020
4015 IF JS = 0 THEN GOTO 4018
4016 IF JS = 1 THEN GOSUB 4900
4017 GOTO 4020
4018 JS = 1
4019 GOTO 4020
4020 CM$ = IN$
4022 SP = INSTR(CM$, " ")
4024 AR$ = ""
4026 IF SP = 0 THEN GOTO 4040
4028 AR$ = MID$(CM$, SP + 1)
4030 CM$ = LEFT$(CM$, SP - 1)
4040 IF CM$ = "CAT" THEN GOTO 4100
4042 IF CM$ = "TYPE" THEN GOTO 4300
4044 IF CM$ = "RUN" THEN GOTO 4500
4046 IF CM$ = "BYE" THEN GOTO 4700
4048 IF CM$ = "SUBMIT" THEN GOTO 5000
4053 IF CM$ = "QUEUE" THEN GOTO 5200
4054 IF CM$ = "PRINT" THEN GOTO 5400
4055 REM anything else
4060 GOSUB 7800
4065 PRINT "DISPLAY 1"
4070 PRINT "?Illegal command"
4075 GOSUB 7900
4080 END
4900 REM ---- RUNNING -> DONE: call the job's program on the bus.
4901 REM Mirrors records.bas's 4252 CALL-emit shape (docs/systems.md 2.3).
4902 REM JP$ names the program the job file named (set at 5000); resolve
4903 REM it to the peer that answers it through the same catalog column
4904 REM 8680 already uses for a captive account's program - one
4905 REM mapping, not a second table.
4906 GOSUB 8100
4925 IF CJ = 0 THEN GOTO 7000
4932 REM CJ's resolution - name match, CALL-only KIND "C", non-blank
4933 REM peer, the same symmetry 4526's guard needs on the EXEC side -
4934 REM all happens once now, in 8100 (review Finding 4). SUBMIT (5000)
4935 REM shares this subroutine, so a job file naming an unresolvable
4936 REM program is refused when submitted, not here two turns later.
4938 PRINT "SYSTEM/1 school-mon OK"
4940 GOSUB 7500
4945 PRINT "DISPLAY 1"
4950 PRINT "JOB " + MID$(STR$(JQ), 2) + " " + JP$ + " RUNNING..."
4955 PRINT "CALL " + CS$(CJ) + " 1"
4960 PRINT "RUN " + JP$
4965 PRINT "LINE UP"
4970 PRINT "END"
4975 END
4980 REM ---- RUN named a catalog row whose EXEC-target is a CALL-only bus
4981 REM peer (KIND "C"), not something RUN can EXEC to - review Finding
4982 REM 1: this used to reach 4540's "EXEC school-ada", which the host
4983 REM rejects as an undeclared exec target (an ordinary keystroke
4984 REM crashing the host, not an in-character refusal).
4985 GOSUB 7800
4990 PRINT "DISPLAY 1"
4993 PRINT "?Batch program - SUBMIT the job instead"
4996 GOSUB 7900
4999 END
5000 REM ---- SUBMIT <job>: enqueue the job file's program. Spool holds
5001 REM exactly one job at a time (design doc 5.3) - a full spool
5002 REM refuses rather than silently replacing what is already running.
5005 IF JQ <> 0 THEN GOTO 5100
5010 J5$ = AR$ + ".CMD"
5015 CF = 0
5020 FOR J = 1 TO NC
5025 IF CN$(J) = J5$ THEN CF = J
5030 NEXT J
5035 IF CF = 0 THEN GOTO 4600
5040 IF CV(CF) > MV THEN GOTO 4640
5045 IF CD$(CF) = "-" THEN GOTO 4600
5046 REM same defensive single-trap ON ERROR as TYPE's 4327: a catalog
5047 REM row flagged readable whose file never made it to disk refuses
5048 REM in-character rather than aborting bwBASIC.
5049 ON ERROR GOSUB 4600
5050 OPEN CD$(CF) FOR INPUT AS #2
5055 LINE INPUT #2, L9$
5060 CLOSE #2
5065 IF LEFT$(L9$, 4) <> "RUN " THEN GOTO 7000
5070 JP$ = MID$(L9$, 5)
5071 REM ---- resolve JP$ now via the shared 8100 resolver (review
5072 REM Finding 4): refuse a job file naming an unresolvable program
5073 GOSUB 8100
5074 IF CJ = 0 THEN GOTO 4600
5075 JQ = JN
5080 JS = 0
5085 JN = JN + 1
5090 JR$ = ""
5095 GOSUB 7800
5096 PRINT "DISPLAY 1"
5097 PRINT "JOB " + MID$(STR$(JQ), 2) + " QUEUED"
5098 GOSUB 7900
5099 END
5100 REM ---- spool full: only one job at a time ----
5105 GOSUB 7800
5110 PRINT "DISPLAY 1"
5115 PRINT "?Batch queue full"
5120 GOSUB 7900
5125 END
5200 REM ---- QUEUE: report the spool's one job. The advance at 4014-4019
5201 REM already ran this turn (it runs on every INPUT before dispatch),
5202 REM and it always turns a QUEUED job (JS=0) into RUNNING (JS=1) before
5203 REM this line is ever reached - QUEUED existed only between SUBMIT
5204 REM setting it and the very next turn's silent bump. So QUEUE can
5205 REM only ever observe RUNNING or DONE for a real job, never QUEUED;
5206 REM design doc 5.3's "QUEUED -> RUNNING -> DONE" is the job's whole
5207 REM life, not a set of readings this command can take.
5208 IF JQ = 0 THEN GOTO 5250
5209 IF JS <> 1 AND JS <> 2 THEN GOTO 7000
5210 GOSUB 7800
5215 PRINT "DISPLAY 1"
5220 IF JS = 1 THEN PRINT "JOB " + MID$(STR$(JQ), 2) + " " + JP$ + " RUNNING"
5225 IF JS = 2 THEN PRINT "JOB " + MID$(STR$(JQ), 2) + " " + JP$ + " DONE"
5230 GOSUB 7900
5235 END
5250 REM ---- empty spool ----
5255 GOSUB 7800
5260 PRINT "DISPLAY 1"
5265 PRINT "NO JOB QUEUED"
5270 GOSUB 7900
5275 END
5400 REM ---- PRINT <job>: emit a completed job's report. Only one job can
5401 REM ever be queued (design doc 5.3), so "the job named AR$" either is
5402 REM the one in JQ or it isn't - no lookup table needed.
5403 REM AR$ must also be a plain digit string (review Finding 7):
5404 REM VAL("412ZZZ") silently reads as 412, so unvalidated trailing
5405 REM garbage could pass the JQ comparison and release the spool.
5406 IF JQ = 0 THEN GOTO 5410
5407 GOSUB 9600
5408 IF NM = 0 THEN GOTO 5410
5409 IF VAL(AR$) = JQ THEN GOTO 5420
5410 REM ---- no such job: an empty spool, or a number that isn't the one
5411 REM queued ----
5412 GOSUB 7800
5414 PRINT "DISPLAY 1"
5416 PRINT "?No such job"
5418 GOSUB 7900
5419 END
5420 IF JS = 2 THEN GOTO 5440
5422 GOSUB 7800
5424 PRINT "DISPLAY 1"
5426 PRINT "?Job " + MID$(STR$(JQ), 2) + " not complete"
5428 GOSUB 7900
5429 END
5440 REM ---- the report: split JR$'s "|"-joined lines the same way 7500
5441 REM does for STATE (9200), and release the spool - the caller has now
5442 REM taken the output, so PRINT is what frees JQ for the next SUBMIT
5443 REM (Task 4 left JQ set forever past JS=2; nothing else in this
5444 REM program ever reads a completed job again). Save the split count
5445 REM in PC before releasing: 7800/7500 calls 9200 again against the
5446 REM now-empty JR$ for the STATE block, which would zero JC first.
5447 GOSUB 9200
5448 PC = JC
5450 JQ = 0
5452 JS = 0
5454 JP$ = ""
5456 JR$ = ""
5458 GOSUB 7800
5460 PRINT "DISPLAY " + MID$(STR$(PC), 2)
5461 IF PC = 0 THEN GOTO 5468
5462 FOR K8 = 1 TO PC
5464 PRINT JL$(K8)
5466 NEXT K8
5468 GOSUB 7900
5470 END
4100 REM ---- CAT: the disk, as far as this account may see it ----
4105 NL = 0
4110 FOR J = 1 TO NC
4115 IF CV(J) <= MV THEN NL = NL + 1
4120 NEXT J
4125 GOSUB 7800
4130 PRINT "DISPLAY " + MID$(STR$(NL + 2), 2)
4133 REM the header sits one column right of its data (#47): the row below
4134 REM starts NAME at 1, PPN at 14 and right-justifies SIZE to 25.
4135 PRINT "NAME         PPN     SIZE"
4140 FOR J = 1 TO NC
4145 IF CV(J) > MV THEN GOTO 4165
4150 L8$ = CN$(J) + SPACE$(13 - LEN(CN$(J)))
4155 L8$ = L8$ + CO$(J) + SPACE$(8 - LEN(CO$(J)))
4157 B8$ = MID$(STR$(CB(J)), 2)
4160 PRINT L8$ + SPACE$(4 - LEN(B8$)) + B8$
4165 NEXT J
4170 PRINT "TOTAL " + MID$(STR$(NL), 2) + " FILES"
4175 GOSUB 7900
4180 END
4300 REM ---- TYPE <file> ----
4305 GOSUB 8800
4310 IF CF = 0 THEN GOTO 4600
4315 IF CV(CF) > MV THEN GOTO 4640
4317 IF CD$(CF) = "-" THEN GOTO 4600
4320 REM two passes: bwBASIC cannot rewind, so count, close, reopen, print
4321 REM the catalog can name a "Y" (readable) row whose file never made
4322 REM it to disk. bwBASIC has no file-exists test and its ON ERROR has
4323 REM no working RESUME, so the first OPEN below is trapped exactly
4324 REM once, refusing in-character (4600) rather than aborting bwBASIC.
4325 NL = 0
4327 ON ERROR GOSUB 4600
4330 OPEN CD$(CF) FOR INPUT AS #2
4335 IF EOF(2) THEN GOTO 4350
4340 LINE INPUT #2, L9$
4345 NL = NL + 1
4347 GOTO 4335
4350 CLOSE #2
4355 GOSUB 7800
4360 PRINT "DISPLAY " + MID$(STR$(NL), 2)
4365 OPEN CD$(CF) FOR INPUT AS #2
4370 IF EOF(2) THEN GOTO 4385
4375 LINE INPUT #2, L9$
4380 PRINT L9$
4382 GOTO 4370
4385 CLOSE #2
4390 GOSUB 7900
4395 END
4500 REM ---- RUN <file> ----
4505 GOSUB 8800
4510 IF CF = 0 THEN GOTO 4600
4515 IF CV(CF) > MV THEN GOTO 4640
4520 IF CS$(CF) = "-" OR CS$(CF) = "" THEN GOTO 4670
4522 REM a batch-only row (KIND "C", e.g. ADAR11.BAS) names a bus peer,
4523 REM not an EXEC target - the host rejects an EXEC naming a peer that
4524 REM was never declared as an exec (review Finding 1); refuse here,
4525 REM in character, rather than let that reach the host as a crash.
4526 IF CK$(CF) <> "E" THEN GOTO 4980
4527 PH$ = "EXEC"
4530 GOSUB 7800
4535 PRINT "DISPLAY 0"
4540 PRINT "EXEC " + CS$(CF)
4545 PRINT "LINE UP"
4550 PRINT "END"
4555 END
4600 REM ---- can't find file or account ----
4605 GOSUB 7800
4610 PRINT "DISPLAY 1"
4615 PRINT "?Can't find file or account"
4620 GOSUB 7900
4625 END
4640 REM ---- protection violation ----
4645 GOSUB 7800
4650 PRINT "DISPLAY 1"
4655 PRINT "?Protection violation"
4660 GOSUB 7900
4665 END
4670 REM ---- on the disk, but not a program ----
4675 GOSUB 7800
4680 PRINT "DISPLAY 1"
4685 PRINT "?Not a runnable file"
4690 GOSUB 7900
4695 END
4700 REM ---- BYE: the monitor really is ending the call, not returning ----
4705 GOSUB 7800
4710 PRINT "DISPLAY 1"
4715 PRINT "GOODBYE."
4720 PRINT "LINE DROP"
4725 PRINT "END"
4730 END
8100 REM ---- resolve JP$ (the job's program name, e.g. "ADAR11") to CJ,
8101 REM the catalog row naming it as a CALL-only bus peer (KIND "C"), or
8102 REM CJ = 0 if it will not resolve. Shared by 4900 (the batch CALL)
8103 REM and 5000 (SUBMIT), so a job file naming an unresolvable program
8104 REM is refused when submitted, not two turns later when 4900 finally
8105 REM tries the CALL (review Finding 4) - one resolver, not two.
8110 P8$ = JP$ + ".BAS"
8120 CJ = 0
8130 FOR J = 1 TO NC
8140 IF CN$(J) <> P8$ THEN GOTO 8160
8150 IF CS$(J) = "-" OR CS$(J) = "" THEN GOTO 8160
8155 IF CK$(J) <> "C" THEN GOTO 8160
8156 CJ = J
8160 NEXT J
8170 RETURN
7800 REM ---- response header + STATE ----
7810 PRINT "SYSTEM/1 school-mon OK"
7820 GOSUB 7500
7830 RETURN
7900 REM ---- ordinary Ready tail ----
7910 PRINT "PROMPT Ready"
7920 PRINT "LINE UP"
7930 PRINT "END"
7940 RETURN
8600 REM ---- load CATLOG.DAT ----
8602 NC = 0
8604 OPEN "data/catlog.dat" FOR INPUT AS #1
8606 IF EOF(1) THEN GOTO 8660
8608 LINE INPUT #1, L9$
8610 NC = NC + 1
8611 IF NC > 40 THEN GOTO 7000
8612 T9$ = LEFT$(L9$, 12)
8613 GOSUB 9000
8614 CN$(NC) = T9$
8615 T9$ = MID$(L9$, 14, 7)
8616 GOSUB 9000
8617 CO$(NC) = T9$
8618 CB(NC) = VAL(MID$(L9$, 22, 3))
8619 CV(NC) = VAL(MID$(L9$, 26, 1))
8620 REM EXEC-target (10 chars, widened from 8 in Task 4) sits at 28-37.
8621 REM KIND at 39 distinguishes an EXEC-able target ("E", used by RUN's
8622 REM 4520 and 8680's captive resolution) from a CALL-only bus peer
8623 REM ("C", used by 4900's batch CALL) - review Finding 1: the column
8624 REM used to do both jobs before, with no way to tell them apart, so
8625 REM RUN ADAR11.BAS emitted an EXEC the host rejected. Flag: 37 -> 41.
8626 CD$(NC) = "-"
8627 T9$ = MID$(L9$, 28, 10)
8628 GOSUB 9000
8629 CS$(NC) = T9$
8630 CK$(NC) = MID$(L9$, 39, 1)
8631 T9$ = MID$(L9$, 41, 1)
8632 GOSUB 9000
8633 CR$(NC) = T9$
8634 REM ---- derive the TYPE path from the catalog itself, not a
8635 REM parallel filename table: a row is typeable iff its EXEC-target
8636 REM is "-" (not another program's dispatch target) and CATLOG.DAT's
8637 REM readable-flag column (41) says "Y". STUDNT.DAT, COURSE.DAT and
8638 REM SCHED.DAT live on systems/school's disk, not this one, so their
8639 REM flag is "N" and CD$ stays "-".
8640 IF CS$(NC) <> "-" THEN GOTO 8650
8641 IF CR$(NC) <> "Y" THEN GOTO 8650
8642 T9$ = CN$(NC)
8643 GOSUB 9100
8644 CD$(NC) = "data/" + T9$
8650 GOTO 8606
8660 CLOSE #1
8665 RETURN
8680 REM ---- resolve captive program ids through the catalog, so there is
8681 REM one mapping (CATLOG.DAT's system-id column) rather than two. A
8682 REM captive account whose program will not resolve to a usable
8683 REM system id is left with AG$ = "-", the same sentinel the catalog
8684 REM itself uses for "no system here" — never a raw or blank id an
8685 REM EXEC could be built from. 3344 depends on that to refuse
8686 REM gracefully rather than hand the host an empty EXEC target.
8687 FOR I = 1 TO NA
8688 IF AC(I) = 0 THEN GOTO 8696
8689 P8$ = AG$(I)
8690 AG$(I) = "-"
8691 FOR J = 1 TO NC
8692 IF CN$(J) <> P8$ + ".BAS" THEN GOTO 8694
8693 IF CS$(J) <> "-" AND CS$(J) <> "" THEN IF CK$(J) = "E" THEN AG$(I) = CS$(J)
8694 NEXT J
8696 NEXT I
8698 RETURN
8800 REM ---- find AR$ in the catalog; CF = index or 0 ----
8810 CF = 0
8820 FOR J = 1 TO NC
8830 IF CN$(J) = AR$ THEN CF = J
8840 NEXT J
8850 RETURN
8900 REM ---- MV = privilege of account AK$, 0 if unknown ----
8905 MV = 0
8910 FOR J = 1 TO NA
8915 IF AP$(J) = AK$ THEN MV = AV(J)
8920 NEXT J
8925 RETURN
8950 REM ---- CP = captive flag of account AK$, 0 if unknown ----
8960 CP = 0
8970 FOR J = 1 TO NA
8980 IF AP$(J) = AK$ THEN CP = AC(J)
8990 NEXT J
8995 RETURN
6000 REM ---- parse one STATE line. RC (init 0, line 212) counts report
6001 REM body lines still owed to JR$ - set by a "REPORT <n>" header
6002 REM (6900) and consumed here by the next RC physical lines
6003 REM regardless of their own content, since a report line could
6004 REM coincidentally start with another field's own prefix. This
6005 REM exists because bwBASIC 2.20 hard-wraps any single PRINT past 79
6006 REM columns, which would silently split a "REPORT " + JR$ one-liner
6007 REM into two physical lines on the wire and desync everything after
6008 REM it - see 7500's matching comment on the emit side.
6009 IF RC > 0 THEN GOTO 6041
6010 IF LEFT$(L$, 6) = "PHASE " THEN PH$ = MID$(L$, 7)
6020 IF LEFT$(L$, 5) = "ACCT " THEN AK$ = MID$(L$, 6)
6030 IF LEFT$(L$, 6) = "TRIES " THEN TR = VAL(MID$(L$, 7))
6032 IF LEFT$(L$, 8) = "NEXTJOB " THEN JN = VAL(MID$(L$, 9))
6034 IF LEFT$(L$, 4) = "JOB " THEN JQ = VAL(MID$(L$, 5))
6036 IF LEFT$(L$, 5) = "STEP " THEN JS = VAL(MID$(L$, 6))
6038 IF LEFT$(L$, 5) = "PROG " THEN JP$ = MID$(L$, 6)
6039 IF LEFT$(L$, 7) = "REPORT " THEN GOSUB 6900
6040 RETURN
6041 REM ---- consuming one report body line into JR$'s in-memory
6042 REM "|"-joined form (task 3's shape - unchanged in memory, only the
6043 REM wire encoding around it changed) ----
6044 REM Both guards below refuse a body line the in-memory form cannot
6045 REM carry, and they refuse it HERE, while the STATE block is still
6046 REM being read and nothing has printed - so the caller gets 7000's
6047 REM whole frame rather than a second header glued onto a half-built
6048 REM one (docs/systems.md 2.2 wants STATE <m> on line 2). 9263/9283
6049 REM check the same two things on the way back out, but by then the
6050 REM response header has gone. A "|" would desync 9200's split and
6051 REM overflow JL$; 80 columns is where bwBASIC 2.20 hard-wraps a
6052 REM PRINT. RESUME guards its own reply lines the same way at 3722.
6053 IF INSTR(L$, "|") > 0 THEN GOTO 7000
6054 IF LEN(L$) >= 80 THEN GOTO 7000
6056 IF JR$ = "" THEN GOTO 6059
6057 JR$ = JR$ + "|" + L$
6058 GOTO 6060
6059 JR$ = L$
6060 RC = RC - 1
6062 RETURN
6900 REM ---- REPORT <n> header: n more physical STATE lines follow, each
6901 REM one report body line ----
6910 RC = VAL(MID$(L$, 8))
6911 IF RC > 12 THEN GOTO 7000
6920 JR$ = ""
6930 RETURN
7000 REM ---- malformed request ----
7010 PRINT "SYSTEM/1 school-mon OK"
7020 PRINT "STATE 0"
7030 PRINT "DISPLAY 1"
7040 PRINT "PROTOCOL ERROR"
7050 PRINT "LINE DROP"
7060 PRINT "END"
7070 END
7500 REM ---- emit the STATE block. REPORT rides as its own "REPORT <n>"
7501 REM sub-block (n raw lines) rather than one "|"-joined PRINT: bwBASIC
7502 REM 2.20 hard-wraps any single PRINT past 79 columns, which would
7503 REM silently split a long "REPORT " + JR$ line into two physical
7504 REM lines on the wire and desync every field after it (empirically
7505 REM confirmed at 79 chars). JR$ itself still holds the pipe-joined
7506 REM form in memory (task 3's shape) - 9200 below splits it back out
7507 REM only for this wire encoding. See 6000's matching comment.
7508 GOSUB 9200
7510 PRINT "STATE " + MID$(STR$(8 + JC), 2)
7520 PRINT "PHASE " + PH$
7530 PRINT "ACCT " + AK$
7540 PRINT "TRIES " + MID$(STR$(TR), 2)
7542 PRINT "NEXTJOB " + MID$(STR$(JN), 2)
7544 PRINT "JOB " + MID$(STR$(JQ), 2)
7546 PRINT "STEP " + MID$(STR$(JS), 2)
7548 PRINT "PROG " + JP$
7549 PRINT "REPORT " + MID$(STR$(JC), 2)
7551 IF JC = 0 THEN GOTO 7560
7552 FOR K8 = 1 TO JC
7554 PRINT JL$(K8)
7556 NEXT K8
7560 RETURN
8490 REM ---- the two loaders below both refuse a file longer than their
8491 REM DIM (40 rows; 4 accounts and 14 catalogue entries ship). Row 41
8492 REM used to be a bare subscript error mid-load - loud since #45's
8493 REM empty-output guard, but as a wrapper failure rather than as this
8494 REM program saying no. Refusing at 7000 makes it a protocol error the
8495 REM caller can read, the same shape 6911 uses for an over-long REPORT.
8500 REM ---- load ACCT.DAT ----
8505 NA = 0
8510 OPEN "data/acct.dat" FOR INPUT AS #1
8515 IF EOF(1) THEN GOTO 8560
8520 LINE INPUT #1, L9$
8525 NA = NA + 1
8526 IF NA > 40 THEN GOTO 7000
8527 T9$ = LEFT$(L9$, 7)
8529 GOSUB 9000
8531 AP$(NA) = T9$
8533 T9$ = MID$(L9$, 9, 12)
8535 GOSUB 9000
8537 AW$(NA) = T9$
8539 AV(NA) = VAL(MID$(L9$, 22, 1))
8541 AC(NA) = VAL(MID$(L9$, 24, 1))
8543 T9$ = MID$(L9$, 26, 8)
8545 GOSUB 9000
8547 AG$(NA) = T9$
8549 GOTO 8515
8560 CLOSE #1
8565 RETURN
8700 REM ---- find the account whose password is IN$; AF = index or 0 ----
8710 AF = 0
8720 FOR J = 1 TO NA
8730 IF AW$(J) = IN$ THEN AF = J
8740 NEXT J
8750 RETURN
9000 REM trim trailing spaces from T9$
9010 IF LEN(T9$) = 0 THEN RETURN
9020 IF RIGHT$(T9$, 1) <> " " THEN RETURN
9030 T9$ = LEFT$(T9$, LEN(T9$) - 1)
9040 GOTO 9010
9200 REM ---- split JR$ (the in-memory "|"-joined report) into JL$(),
9201 REM count JC. Used by the STATE emitter (7500), the same wire-safety
9202 REM step so no single PRINT exceeds bwBASIC's 79-column line wrap, and
9203 REM by PRINT (5440), which needs the same lines split for its DISPLAY
9204 REM body - one split routine, not two.
9210 JC = 0
9220 W9$ = JR$
9230 IF LEN(W9$) = 0 THEN RETURN
9240 P9 = INSTR(W9$, "|")
9250 IF P9 = 0 THEN GOTO 9280
9260 JC = JC + 1
9262 JL$(JC) = LEFT$(W9$, P9 - 1)
9263 IF LEN(JL$(JC)) >= 80 THEN GOTO 7000
9264 W9$ = MID$(W9$, P9 + 1)
9270 GOTO 9240
9280 JC = JC + 1
9282 JL$(JC) = W9$
9283 IF LEN(JL$(JC)) >= 80 THEN GOTO 7000
9290 RETURN
9100 REM lowercase T9$ in place (period-plausible: CHR$/ASC arithmetic)
9110 L7$ = ""
9120 FOR I7 = 1 TO LEN(T9$)
9130 C7$ = MID$(T9$, I7, 1)
9140 IF C7$ >= "A" AND C7$ <= "Z" THEN C7$ = CHR$(ASC(C7$) + 32)
9150 L7$ = L7$ + C7$
9160 NEXT I7
9170 T9$ = L7$
9180 RETURN
9600 REM ---- validate AR$ is a plain non-negative integer: every char a
9601 REM digit, at least one char. NM = 1 if so, 0 otherwise (review
9602 REM Finding 7 - VAL() alone accepts "412ZZZ" as 412).
9610 NM = 0
9620 IF LEN(AR$) = 0 THEN RETURN
9630 FOR I9 = 1 TO LEN(AR$)
9640 C9$ = MID$(AR$, I9, 1)
9650 IF C9$ < "0" OR C9$ > "9" THEN RETURN
9660 NEXT I9
9670 NM = 1
9680 RETURN
