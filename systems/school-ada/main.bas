10 REM SEATTLE PUBLIC SCHOOL DISTRICT - SYSTEM/1 school-ada (ADAR11)
20 REM The state average-daily-attendance claim - the reason the machine
30 REM exists (docs/superpowers/specs/2026-08-03-period-installations-design.md
40 REM section 4). A bus-only batch peer: no `number` in its manifest, so
50 REM it is not dialable; the district's job queue reaches it with a
60 REM bus CALL (Task 4). Nothing calls it yet - this program only has to
70 REM answer the wire below correctly on its own.
80 REM
90 REM This is ADAR11's OWN wire, a one-shot batch job - not the general
100 REM CALL/REPLY continuation extension of docs/systems.md 2.3 (which is a
110 REM RESPONSE-side block a system emits mid-turn to ask a peer something
120 REM and be resumed). ADAR11 never continues: it is invoked once, answers
130 REM once, and exits. No STATE rides between turns, and there is no
140 REM DISPLAY/LINE block - the report is consumed by the job queue that
150 REM called it, not painted on a terminal (Task 5 formats a printed
160 REM report from it for the caller).
170 REM
180 REM Request:
190 REM   SYSTEM/1 school-ada CALL
200 REM   STATE 0
210 REM   RUN ADAR11
220 REM   END
230 REM
240 REM Response (n = number of buildings read off CALEND.DAT):
250 REM   REPLY school-ada OK <n>
260 REM   <n lines: BUILDING ENROLLED ADM ADA, one per building>
270 REM   DISTRICT <ADM> <ADA>
280 REM   END
290 REM
300 REM Field widths - fixed here; Task 5's PRINT job formats from these
310 REM exactly, so they must not move without updating that caller too:
320 REM   BUILDING   7 chars, left-justified, space-padded
330 REM   ENROLLED   5 chars, right-justified integer
340 REM   ADM        7 chars, right-justified, 2 decimals (e.g. " 320.00")
350 REM   ADA        7 chars, right-justified, 2 decimals
360 REM Fields are separated by one space. A building line is therefore
370 REM exactly 7+1+5+1+7+1+7 = 29 characters. The DISTRICT line is the
380 REM literal "DISTRICT" (8 chars) + space + ADM(7) + space + ADA(7) = 24.
390 REM
400 REM ADA = aggregate days attended / instructional days (ADANOT.DOC,
410 REM systems/school-mon/data/adanot.doc). Documented approximation: this
420 REM pilot has no per-student attendance record anywhere on the disk -
430 REM absence tracking is out of scope through phase 3 (design doc
440 REM section 10) - so every enrolled pupil is modeled as present every
450 REM instructional day. ADM (average daily membership) is then
460 REM algebraically equal to ENROLLED too: a static, single-snapshot
470 REM roster has no day-to-day membership change either. CALEND.DAT's
480 REM instructional-day counts are still read and used as the formula's
490 REM actual divisor - they do not change the result under this
500 REM assumption, but the computation is not hardcoded around them, and
510 REM the divisor would matter the moment absence data exists.
520 REM
530 REM The roster (systems/school/data/students.dat) carries no building
540 REM column (see that program's 8500 loader), so its whole headcount is
550 REM attributed to the one building named on CALEND.DAT (today, HIGH).
560 REM A second building would need a roster building column to split the
570 REM headcount correctly - out of scope here, so 950 below refuses
580 REM rather than silently misreport if CALEND.DAT ever names more than
590 REM one.
600 DIM BN$(10)
610 DIM BD(10)
700 REM ---- parse the SYSTEM/1 request from stdin ----
710 LINE INPUT H$
720 IF LEFT$(H$, 20) <> "SYSTEM/1 school-ada " THEN GOTO 7000
730 C$ = MID$(H$, 21)
740 IF C$ <> "CALL" THEN GOTO 7000
750 LINE INPUT S$
760 IF LEFT$(S$, 6) <> "STATE " THEN GOTO 7000
770 SN = VAL(MID$(S$, 7))
780 REM this program carries no state between turns
790 IF SN <> 0 THEN GOTO 7000
800 LINE INPUT P$
810 IF P$ <> "RUN ADAR11" THEN GOTO 7000
820 LINE INPUT E$
830 IF E$ <> "END" THEN GOTO 7000
900 REM ---- RUN ADAR11: compute the claim ----
910 GOSUB 8500
920 GOSUB 8600
930 REM defensive: 1040 attributes the whole roster to one building; see
940 REM the header note above.
950 IF NB <> 1 THEN GOTO 7000
1000 TM = 0
1010 TT = 0
1020 PRINT "REPLY school-ada OK " + MID$(STR$(NB), 2)
1030 FOR I = 1 TO NB
1040 ER = NS
1050 MD = ER * BD(I)
1060 TM = TM + MD
1070 TT = TT + BD(I)
1080 N2 = MD / BD(I)
1090 W2 = 7
1100 GOSUB 9200
1110 A1$ = F2$
1120 N2 = MD / BD(I)
1130 GOSUB 9200
1140 A2$ = F2$
1150 T4$ = BN$(I)
1160 W4 = 7
1170 GOSUB 9500
1180 N3 = ER
1190 W3 = 5
1200 GOSUB 9400
1210 PRINT T4$ + " " + I3$ + " " + A1$ + " " + A2$
1220 NEXT I
1230 N2 = TM / TT
1240 W2 = 7
1250 GOSUB 9200
1260 D1$ = F2$
1270 GOSUB 9200
1280 D2$ = F2$
1290 PRINT "DISTRICT " + D1$ + " " + D2$
1300 PRINT "END"
1310 END
7000 REM ---- malformed request, or a data shape this program cannot yet
7010 REM attribute correctly: refuse loudly rather than misreport ----
7020 PRINT "REPLY school-ada FAIL 0"
7030 PRINT "PROTOCOL ERROR"
7040 PRINT "END"
7050 END
8500 REM ---- load the roster; NS = enrolled headcount. This program only
8510 REM needs the count, not per-student fields - ADAR11 never touches
8520 REM grades or schedule.
8530 NS = 0
8540 OPEN "../school/data/students.dat" FOR INPUT AS #1
8550 IF EOF(1) THEN GOTO 8570
8560 LINE INPUT #1, L9$
8562 NS = NS + 1
8564 GOTO 8550
8570 CLOSE #1
8580 RETURN
8600 REM ---- load CALEND.DAT: month, building, instructional days ----
8610 REM Layout (fixed width, ASCII, LF): cols 1-3 month, col 4 space, cols
8620 REM 5-11 building (7, left-justified), cols 12-13 days (2 digits).
8630 NB = 0
8640 OPEN "data/calend.dat" FOR INPUT AS #1
8650 IF EOF(1) THEN GOTO 8730
8660 LINE INPUT #1, L9$
8670 T9$ = MID$(L9$, 5, 7)
8672 GOSUB 9000
8680 BI = 0
8690 FOR J = 1 TO NB
8700 IF BN$(J) = T9$ THEN BI = J
8710 NEXT J
8712 IF BI > 0 THEN GOTO 8722
8714 NB = NB + 1
8716 BN$(NB) = T9$
8718 BD(NB) = 0
8720 BI = NB
8722 BD(BI) = BD(BI) + VAL(MID$(L9$, 12, 2))
8724 GOTO 8650
8730 CLOSE #1
8740 RETURN
9000 REM trim trailing spaces from T9$
9010 IF LEN(T9$) = 0 THEN RETURN
9020 IF RIGHT$(T9$, 1) <> " " THEN RETURN
9030 T9$ = LEFT$(T9$, LEN(T9$) - 1)
9040 GOTO 9010
9200 REM ---- format N2 into F2$: fixed 2 decimals, right-justified in
9210 REM field width W2. Rounds to the nearest cent.
9220 WI = INT(N2)
9230 FR = INT((N2 - WI) * 100 + 0.5)
9240 IF FR < 100 THEN GOTO 9270
9250 FR = FR - 100
9260 WI = WI + 1
9270 FR$ = MID$(STR$(FR), 2)
9280 IF LEN(FR$) >= 2 THEN GOTO 9300
9290 FR$ = "0" + FR$
9300 F2$ = MID$(STR$(WI), 2) + "." + FR$
9310 IF LEN(F2$) >= W2 THEN GOTO 9330
9320 F2$ = SPACE$(W2 - LEN(F2$)) + F2$
9330 RETURN
9400 REM ---- format integer N3 into I3$: right-justified in field width W3
9410 I3$ = MID$(STR$(N3), 2)
9420 IF LEN(I3$) >= W3 THEN GOTO 9440
9430 I3$ = SPACE$(W3 - LEN(I3$)) + I3$
9440 RETURN
9500 REM ---- left-justify T4$ into field width W4 ----
9510 IF LEN(T4$) >= W4 THEN GOTO 9530
9520 T4$ = T4$ + SPACE$(W4 - LEN(T4$))
9530 RETURN
