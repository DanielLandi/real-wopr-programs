10 REM SEATTLE PUBLIC SCHOOL DISTRICT - SYSTEM/1 school
20 REM Menu-driven administrative datanet in plain line-numbered BASIC,
30 REM run by the Bywater BASIC interpreter. Stateless per invocation:
40 REM the session (menu step, work-in-progress grade entry, roster-
50 REM listing cursor, a GRD cache) rides the opaque STATE block, echoed
60 REM back each turn per docs/systems.md. Authentication is not this
65 REM program's job: the monitor (school-mon) checks it before EXEC'ing
67 REM here, so there is no password state to carry. No wall
70 REM clock and no rng, so same request bytes give the same response.
72 REM The grades themselves are NOT here: they live in school-db, on the
74 REM local bus. This program owns the roster and the schedule and asks
76 REM the records store for anything about a grade (CALL/REPLY).
78 REM The roster, the schedule and the course catalog are fixed-width
79 REM flat files under data/ (layouts in tools/gen-systems-data.py),
80 REM RSTS/E-fashion; the program re-reads them into its arrays at
81 REM every spawn. The harness wrapper chdirs here first.
82 DIM NM$(400)
83 DIM SID(400)
84 DIM IX(400)
85 DIM GL$(400)
86 DIM CO(2200)
87 DIM CN$(2200)
88 DIM CT$(60)
89 DIM CD$(60)
90 DIM GS$(40)
92 DIM GC$(40)
94 DIM GG$(40)
95 DIM RL$(40)
96 GOSUB 8500
100 REM ---- parse the SYSTEM/1 request from stdin ----
110 LINE INPUT H$
120 IF LEFT$(H$, 16) <> "SYSTEM/1 school " THEN GOTO 7000
130 CMD$ = MID$(H$, 17)
140 LINE INPUT S$
150 IF LEFT$(S$, 6) <> "STATE " THEN GOTO 7000
160 SN = VAL(MID$(S$, 7))
200 REM resting-session defaults; overwritten by parsed STATE lines
230 ST$ = "MENU"
240 WP$ = "-"
250 WC$ = "-"
260 NG = 0
270 IF SN <= 0 THEN GOTO 400
280 FOR I = 1 TO SN
290 LINE INPUT L$
300 GOSUB 6000
310 NEXT I
400 REM trailing block: INPUT <line>, REPLY <peer> <status> <n>, or END
410 LINE INPUT T$
420 HI = 0
422 RS$ = "-"
424 NR = 0
426 IF LEFT$(T$, 6) = "REPLY " THEN GOTO 530
430 IF LEFT$(T$, 6) <> "INPUT " THEN GOTO 500
440 IN$ = MID$(T$, 7)
450 HI = 1
460 LINE INPUT E$
470 IF E$ <> "END" THEN GOTO 7000
480 GOTO 600
500 IF T$ <> "END" THEN GOTO 7000
510 GOTO 600
530 REM the answer to the CALL made last turn
532 R9$ = MID$(T$, 7)
534 SP9 = INSTR(R9$, " ")
536 IF SP9 = 0 THEN GOTO 7000
538 R9$ = MID$(R9$, SP9 + 1)
540 SP9 = INSTR(R9$, " ")
542 IF SP9 = 0 THEN GOTO 7000
544 RS$ = LEFT$(R9$, SP9 - 1)
546 NR = VAL(MID$(R9$, SP9 + 1))
548 IF NR <= 0 THEN GOTO 556
549 REM bwBASIC 2.20's LINE INPUT wants a scalar: it rejects an array
550 REM element ("String variable required"), so read then assign.
551 FOR K = 1 TO NR
552 LINE INPUT RX$
553 RL$(K) = RX$
554 NEXT K
556 LINE INPUT E$
558 IF E$ <> "END" THEN GOTO 7000
600 REM ---- dispatch on command ----
610 IF CMD$ = "CONNECT" THEN GOTO 3000
620 IF CMD$ = "INPUT" THEN GOTO 3300
625 IF CMD$ = "RESUME" THEN GOTO 3900
630 GOTO 7000
3000 REM CONNECT: the monitor has already authenticated this caller and
3005 REM EXEC'd us, so there is no password to ask for. Paint the menu.
3010 PRINT "SYSTEM/1 school OK"
3020 GOSUB 7500
3030 PRINT "DISPLAY 7"
3040 PRINT "WELCOME TO DISTRICT DATANET"
3050 GOSUB 7700
3060 PRINT "LINE UP"
3070 PRINT "END"
3080 END
3300 REM INPUT: an INPUT command must carry a user line
3310 IF HI = 0 THEN GOTO 7000
3320 GOTO 3700
3700 REM authenticated: route by the menu step carried in STATE
3710 IF ST$ = "MENU" THEN GOTO 4000
3720 IF ST$ = "RECNAME" THEN GOTO 4200
3730 IF ST$ = "GRNAME" THEN GOTO 4400
3740 IF ST$ = "GRCOURSE" THEN GOTO 4500
3750 IF ST$ = "GRVALUE" THEN GOTO 4600
3760 IF ST$ = "LSTS" THEN GOTO 5600
3770 IF ST$ = "LSTC" THEN GOTO 5800
3780 GOTO 7000
3900 REM RESUME: school-db has answered the CALL made last turn
3905 IF ST$ = "AWAITREC" THEN GOTO 3920
3910 IF ST$ = "AWAITSET" THEN GOTO 3960
3915 GOTO 7000
3920 REM the record came back (or did not)
3922 ST$ = "MENU"
3924 FS = VAL(WP$)
3926 WP$ = "-"
3928 IF RS$ <> "OK" THEN GOTO 3950
3930 PRINT "SYSTEM/1 school OK"
3932 GOSUB 7500
3934 DC = 1 + NR + 6
3936 PRINT "DISPLAY " + MID$(STR$(DC), 2)
3938 PRINT "STUDENT: " + NM$(IX(FS)) + "   GRADE " + GL$(IX(FS))
3940 FOR K = 1 TO NR
3942 PRINT RL$(K)
3944 NEXT K
3946 GOSUB 7700
3947 PRINT "LINE UP"
3948 PRINT "END"
3949 END
3950 REM the records store did not answer. Say so; do not hang the line.
3951 PRINT "SYSTEM/1 school OK"
3952 GOSUB 7500
3953 PRINT "DISPLAY 7"
3954 PRINT "RECORDS UNAVAILABLE"
3955 GOSUB 7700
3956 PRINT "LINE UP"
3957 PRINT "END"
3958 END
3960 REM the grade was recorded (or was not)
3962 ST$ = "MENU"
3964 WP$ = "-"
3966 WC$ = "-"
3968 IF RS$ <> "OK" THEN GOTO 3950
3970 PRINT "SYSTEM/1 school OK"
3972 GOSUB 7500
3974 PRINT "DISPLAY 7"
3976 PRINT "RECORD UPDATED."
3978 GOSUB 7700
3980 PRINT "LINE UP"
3982 PRINT "END"
3984 END
4000 REM main-menu selection
4010 IF IN$ = "1" THEN GOTO 4100
4020 IF IN$ = "2" THEN GOTO 4300
4030 IF IN$ = "3" THEN GOTO 5000
4040 IF IN$ = "4" THEN GOTO 5200
4050 IF IN$ = "LIST" THEN GOTO 5500
4060 IF LEFT$(IN$, 5) = "LIST " THEN GOTO 5500
4070 IF IN$ = "COURSES" THEN GOTO 5700
4080 IF LEFT$(IN$, 8) = "COURSES " THEN GOTO 5700
4090 GOTO 5400
4100 REM option 1: records - ask for the student name
4110 ST$ = "RECNAME"
4120 PRINT "SYSTEM/1 school OK"
4130 GOSUB 7500
4140 PRINT "DISPLAY 0"
4150 PRINT "PROMPT STUDENT NAME:"
4160 PRINT "LINE UP"
4170 PRINT "END"
4180 END
4200 REM show the record for the entered name (prefix match). The grades are
4202 REM not ours: ask school-db and resume when it answers.
4210 US$ = IN$
4220 GOSUB 6500
4230 IF FS = 0 THEN GOTO 4280
4240 ST$ = "AWAITREC"
4242 WP$ = MID$(STR$(FS), 2)
4244 PRINT "SYSTEM/1 school OK"
4246 GOSUB 7500
4248 PRINT "DISPLAY 1"
4250 PRINT "SEARCHING..."
4252 PRINT "CALL school-db 1"
4254 PRINT "RECORD " + WP$
4256 PRINT "LINE UP"
4258 PRINT "END"
4270 END
4280 REM name not on file
4282 ST$ = "MENU"
4284 PRINT "SYSTEM/1 school OK"
4286 GOSUB 7500
4288 PRINT "DISPLAY 7"
4290 PRINT "NO RECORD ON FILE"
4292 GOSUB 7700
4294 PRINT "LINE UP"
4296 PRINT "END"
4298 END
4300 REM option 2: grade entry - ask for the student name
4310 ST$ = "GRNAME"
4320 PRINT "SYSTEM/1 school OK"
4330 GOSUB 7500
4340 PRINT "DISPLAY 0"
4350 PRINT "PROMPT GRADE ENTRY - STUDENT NAME:"
4360 PRINT "LINE UP"
4370 PRINT "END"
4380 END
4400 REM grade entry: resolve the surname, then ask for the course
4410 US$ = IN$
4420 GOSUB 6500
4430 IF FS = 0 THEN GOTO 4460
4440 WP$ = MID$(STR$(FS), 2)
4442 ST$ = "GRCOURSE"
4444 PRINT "SYSTEM/1 school OK"
4446 GOSUB 7500
4448 PRINT "DISPLAY 0"
4450 PRINT "PROMPT COURSE:"
4452 PRINT "LINE UP"
4454 PRINT "END"
4456 END
4460 REM name not on file
4462 ST$ = "MENU"
4464 PRINT "SYSTEM/1 school OK"
4466 GOSUB 7500
4468 PRINT "DISPLAY 7"
4470 PRINT "NO RECORD ON FILE"
4472 GOSUB 7700
4474 PRINT "LINE UP"
4476 PRINT "END"
4478 END
4500 REM grade entry: the course must be on the student's schedule
4505 WPN = VAL(WP$)
4510 CE = 0
4512 FOR CI = 1 TO TC
4514 IF CO(CI) = WPN AND CN$(CI) = IN$ THEN CE = 1
4516 NEXT CI
4518 IF CE = 0 THEN GOTO 4560
4520 WC$ = IN$
4522 ST$ = "GRVALUE"
4524 PRINT "SYSTEM/1 school OK"
4526 GOSUB 7500
4528 PRINT "DISPLAY 0"
4530 PRINT "PROMPT NEW GRADE:"
4532 PRINT "LINE UP"
4534 PRINT "END"
4536 END
4560 REM course not on the student's schedule; abort the entry
4562 ST$ = "MENU"
4563 WP$ = "-"
4564 PRINT "SYSTEM/1 school OK"
4566 GOSUB 7500
4568 PRINT "DISPLAY 7"
4570 PRINT "NO SUCH COURSE FOR STUDENT"
4572 GOSUB 7700
4574 PRINT "LINE UP"
4576 PRINT "END"
4578 END
4600 REM grade entry: the new grade must be a single letter A-F
4602 GV = 0
4604 IF LEN(IN$) = 1 AND IN$ >= "A" AND IN$ <= "F" THEN GV = 1
4606 IF GV = 1 THEN GOTO 4610
4608 GOTO 4720
4610 REM valid grade: the store holds the grades, so ask it to record this
4612 ST$ = "AWAITSET"
4614 PRINT "SYSTEM/1 school OK"
4616 GOSUB 7500
4618 PRINT "DISPLAY 1"
4620 PRINT "RECORDING..."
4622 PRINT "CALL school-db 1"
4624 PRINT "SET GRADE " + WP$ + " " + WC$ + " " + IN$
4626 PRINT "LINE UP"
4628 PRINT "END"
4706 END
4720 REM invalid grade: report and return to menu without mutating
4722 ST$ = "MENU"
4724 WP$ = "-"
4726 WC$ = "-"
4728 PRINT "SYSTEM/1 school OK"
4730 GOSUB 7500
4732 PRINT "DISPLAY 7"
4734 PRINT "GRADE MUST BE A-F"
4736 GOSUB 7700
4738 PRINT "LINE UP"
4740 PRINT "END"
4742 END
5000 REM option 3: attendance is not entered here - it is a batch job the
5001 REM operator runs at the console, so this program can only explain
5002 REM that and refuse interactive entry.
5010 PRINT "SYSTEM/1 school OK"
5020 GOSUB 7500
5030 PRINT "DISPLAY 8"
5040 PRINT "ATTENDANCE IS POSTED FROM THE MONTHLY REGISTERS."
5042 PRINT "ADARUN IS SUBMITTED FROM THE SYSTEM CONSOLE."
5050 GOSUB 7700
5060 PRINT "LINE UP"
5070 PRINT "END"
5080 END
5200 REM option 4: log off and return to whatever EXEC'd us
5230 ST$ = "MENU"
5240 WP$ = "-"
5250 WC$ = "-"
5260 NG = 0
5270 PRINT "SYSTEM/1 school OK"
5280 GOSUB 7500
5290 PRINT "DISPLAY 1"
5292 PRINT "LOGGED OFF. GOODBYE."
5294 PRINT "LINE RETURN"
5296 PRINT "END"
5298 END
5400 REM unrecognized menu selection
5410 PRINT "SYSTEM/1 school OK"
5420 GOSUB 7500
5430 PRINT "DISPLAY 7"
5440 PRINT "INVALID SELECTION"
5450 GOSUB 7700
5460 PRINT "LINE UP"
5470 PRINT "END"
5480 END
5500 REM LIST [NAME*]: roster listing, 15 rows to a page. The optional
5502 REM pattern is a starts-with prefix over the roster name; a
5504 REM trailing * is tolerated. The page cursor and pattern ride the
5506 REM STATE block (STEP LSTS, WIP = next row, WIPC = pattern).
5510 P9$ = ""
5512 IF LEN(IN$) > 5 THEN P9$ = MID$(IN$, 6)
5514 IF LEN(P9$) > 0 THEN IF RIGHT$(P9$, 1) = "*" THEN P9$ = LEFT$(P9$, LEN(P9$) - 1)
5516 CUR = 1
5518 GOTO 5900
5600 REM STEP LSTS: M turns the page; anything else ends the listing
5610 IF IN$ <> "M" THEN GOTO 6300
5620 CUR = VAL(WP$)
5630 P9$ = WC$
5640 IF P9$ = "-" THEN P9$ = ""
5650 GOTO 5900
5700 REM COURSES [PFX*]: course-catalog listing, same paging as LIST
5710 P9$ = ""
5712 IF LEN(IN$) > 8 THEN P9$ = MID$(IN$, 9)
5714 IF LEN(P9$) > 0 THEN IF RIGHT$(P9$, 1) = "*" THEN P9$ = LEFT$(P9$, LEN(P9$) - 1)
5716 CUR = 1
5718 GOTO 6600
5800 REM STEP LSTC: M turns the page; anything else ends the listing
5810 IF IN$ <> "M" THEN GOTO 6300
5820 CUR = VAL(WP$)
5830 P9$ = WC$
5840 IF P9$ = "-" THEN P9$ = ""
5850 GOTO 6600
5900 REM ---- emit one roster page from row CUR, prefix P9$ ----
5905 N9 = 0
5910 PX = 0
5915 FOR SI = CUR TO NS
5920 IF LEFT$(NM$(SI), LEN(P9$)) <> P9$ THEN GOTO 5945
5925 IF PX > 0 THEN GOTO 5945
5930 IF N9 = 15 THEN PX = SI : GOTO 5945
5935 N9 = N9 + 1
5940 RL$(N9) = RIGHT$("000" + MID$(STR$(SID(SI)), 2), 4) + "  " + NM$(SI) + SPACE$(32 - LEN(NM$(SI))) + GL$(SI)
5945 NEXT SI
5950 T9$ = "** STUDENT ROSTER **"
5955 S9$ = "LSTS"
5960 GOTO 6350
6600 REM ---- emit one catalog page from row CUR, prefix P9$ ----
6605 N9 = 0
6610 PX = 0
6615 FOR CI = CUR TO CC
6620 IF LEFT$(CT$(CI), LEN(P9$)) <> P9$ THEN GOTO 6645
6625 IF PX > 0 THEN GOTO 6645
6630 IF N9 = 15 THEN PX = CI : GOTO 6645
6635 N9 = N9 + 1
6640 RL$(N9) = CT$(CI) + SPACE$(16 - LEN(CT$(CI))) + CD$(CI)
6645 NEXT CI
6650 T9$ = "** COURSE CATALOG **"
6655 S9$ = "LSTC"
6660 GOTO 6350
6300 REM a non-M entry at a MORE prompt ends the listing
6310 ST$ = "MENU"
6312 WP$ = "-"
6314 WC$ = "-"
6320 PRINT "SYSTEM/1 school OK"
6322 GOSUB 7500
6324 PRINT "DISPLAY 7"
6326 PRINT "END OF LIST"
6328 GOSUB 7700
6330 PRINT "LINE UP"
6332 PRINT "END"
6334 END
6350 REM ---- shared page printer: N9 rows, PX cursor, T9$ title ----
6355 IF N9 > 0 THEN GOTO 6380
6360 ST$ = "MENU"
6362 WP$ = "-"
6364 WC$ = "-"
6366 PRINT "SYSTEM/1 school OK"
6368 GOSUB 7500
6370 PRINT "DISPLAY 7"
6372 PRINT "NO MATCH"
6374 GOSUB 7700
6376 PRINT "LINE UP"
6378 PRINT "END"
6379 END
6380 IF PX = 0 THEN GOTO 6440
6385 REM more rows remain: park the cursor in the STATE block
6390 ST$ = S9$
6392 WP$ = MID$(STR$(PX), 2)
6394 WC$ = P9$
6396 IF WC$ = "" THEN WC$ = "-"
6400 PRINT "SYSTEM/1 school OK"
6402 GOSUB 7500
6404 PRINT "DISPLAY " + MID$(STR$(N9 + 1), 2)
6406 PRINT T9$
6410 FOR K = 1 TO N9
6412 PRINT RL$(K)
6414 NEXT K
6418 PRINT "PROMPT MORE - TYPE M"
6420 PRINT "LINE UP"
6422 PRINT "END"
6424 END
6440 REM final page: rows, END OF LIST, back to the menu
6442 ST$ = "MENU"
6444 WP$ = "-"
6446 WC$ = "-"
6448 PRINT "SYSTEM/1 school OK"
6450 GOSUB 7500
6452 PRINT "DISPLAY " + MID$(STR$(N9 + 8), 2)
6454 PRINT T9$
6458 FOR K = 1 TO N9
6460 PRINT RL$(K)
6462 NEXT K
6464 PRINT "END OF LIST"
6466 GOSUB 7700
6468 PRINT "LINE UP"
6470 PRINT "END"
6472 END
6000 REM ---- parse one opaque STATE line in L$ ----
6030 IF LEFT$(L$, 5) = "STEP " THEN ST$ = MID$(L$, 6)
6040 IF LEFT$(L$, 5) = "WIPC " THEN WC$ = MID$(L$, 6)
6050 IF LEFT$(L$, 4) = "WIP " THEN WP$ = MID$(L$, 5)
6060 IF LEFT$(L$, 4) = "GRD " THEN GOSUB 6100
6070 RETURN
6100 REM parse "GRD <id> <course...> <grade>" into the GRD arrays
6110 R$ = MID$(L$, 5)
6120 SP1 = INSTR(R$, " ")
6130 GID$ = LEFT$(R$, SP1 - 1)
6140 R2$ = MID$(R$, SP1 + 1)
6150 LP = 0
6160 FOR K = 1 TO LEN(R2$)
6170 IF MID$(R2$, K, 1) = " " THEN LP = K
6180 NEXT K
6190 NG = NG + 1
6200 GS$(NG) = GID$
6210 GC$(NG) = LEFT$(R2$, LP - 1)
6220 GG$(NG) = MID$(R2$, LP + 1)
6230 RETURN
6500 REM resolve typed name US$ to a student id FS (0 if none).
6502 REM key = first token before a space or comma; prefix-match the
6504 REM full roster name in file (alphabetical) order, first match
6506 REM wins; the winner's file id is the answer.
6508 KP = INSTR(US$, " ")
6510 KQ = INSTR(US$, ",")
6512 KD = KP
6514 IF KD = 0 THEN KD = KQ
6516 IF KQ > 0 AND KQ < KD THEN KD = KQ
6518 KEY$ = US$
6520 IF KD > 0 THEN KEY$ = LEFT$(US$, KD - 1)
6522 FS = 0
6524 IF KEY$ = "" THEN RETURN
6526 FOR SI = 1 TO NS
6528 IF LEFT$(NM$(SI), LEN(KEY$)) = KEY$ AND FS = 0 THEN FS = SID(SI)
6530 NEXT SI
6532 RETURN
7000 REM protocol error: fixed drop response (wrapper exits non-zero)
7010 PRINT "SYSTEM/1 school OK"
7020 PRINT "STATE 1"
7030 PRINT "0"
7040 PRINT "DISPLAY 1"
7050 PRINT "PROTOCOL ERROR"
7060 PRINT "LINE DROP"
7070 PRINT "END"
7080 END
7500 REM ---- emit the STATE block: 3 resting tags + NG GRD lines ----
7510 SC = 3 + NG
7520 PRINT "STATE " + MID$(STR$(SC), 2)
7530 PRINT "STEP " + ST$
7540 PRINT "WIP " + WP$
7550 PRINT "WIPC " + WC$
7560 IF NG <= 0 THEN RETURN
7570 FOR GI = 1 TO NG
7580 PRINT "GRD " + GS$(GI) + " " + GC$(GI) + " " + GG$(GI)
7590 NEXT GI
7600 RETURN
7700 REM emit the 6-line main menu (MENU6)
7710 PRINT "1 - STUDENT RECORDS"
7720 PRINT "2 - GRADE ENTRY"
7730 PRINT "3 - ATTENDANCE"
7740 PRINT "4 - LOG OFF"
7745 PRINT "LIST - STUDENT ROSTER (LIST A* TO FILTER)"
7747 PRINT "COURSES - COURSE CATALOG (COURSES MA* TO FILTER)"
7755 PRINT "PROMPT SELECT:"
7760 RETURN
8500 REM ---- load roster, schedule and catalog from the data files ----
8505 NS = 0
8510 OPEN "data/students.dat" FOR INPUT AS #1
8515 IF EOF(1) THEN GOTO 8545
8520 LINE INPUT #1, L9$
8525 NS = NS + 1
8527 SID(NS) = VAL(LEFT$(L9$, 4))
8529 T9$ = MID$(L9$, 6, 30)
8531 GOSUB 9000
8533 NM$(NS) = T9$
8535 T9$ = MID$(L9$, 37, 2)
8537 GOSUB 9000
8539 GL$(NS) = T9$
8541 IX(SID(NS)) = NS
8543 GOTO 8515
8545 CLOSE #1
8550 TC = 0
8555 OPEN "data/schedule.dat" FOR INPUT AS #1
8560 IF EOF(1) THEN GOTO 8585
8565 LINE INPUT #1, L9$
8570 TC = TC + 1
8572 CO(TC) = VAL(LEFT$(L9$, 4))
8574 T9$ = MID$(L9$, 6, 14)
8576 GOSUB 9000
8578 CN$(TC) = T9$
8580 GOTO 8560
8585 CLOSE #1
8590 CC = 0
8595 OPEN "data/courses.dat" FOR INPUT AS #1
8600 IF EOF(1) THEN GOTO 8635
8605 LINE INPUT #1, L9$
8610 CC = CC + 1
8615 T9$ = LEFT$(L9$, 14)
8620 GOSUB 9000
8622 CT$(CC) = T9$
8625 T9$ = MID$(L9$, 16, 6) + "  " + MID$(L9$, 23, 12)
8627 GOSUB 9000
8629 CD$(CC) = T9$
8631 GOTO 8600
8635 CLOSE #1
8640 RETURN
9000 REM trim trailing spaces from T9$
9010 IF LEN(T9$) = 0 THEN RETURN
9020 IF RIGHT$(T9$, 1) <> " " THEN RETURN
9030 T9$ = LEFT$(T9$, LEN(T9$) - 1)
9040 GOTO 9010
