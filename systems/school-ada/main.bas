10 REM SEATTLE PUBLIC SCHOOL DISTRICT - SYSTEM/1 school-ada (ADAR11)
20 REM The state average-daily-attendance claim - the reason the machine
30 REM exists (docs/superpowers/specs/2026-08-03-period-installations-design.md
40 REM section 4). A bus-only peer: no `number` in its manifest, so it is
50 REM not dialable; the district's job queue reaches it with an ordinary
60 REM bus CALL (Task 4). Nothing calls it yet - this program only has to
70 REM answer the wire below correctly on its own.
80 REM
90 REM Corrected wire (docs/systems.md 2.1, 2.3; PACK.md's "Wire protocols"):
100 REM a CALL's callee is invoked exactly like any other system - command
110 REM INPUT, its own STATE, one INPUT <payload> line - and answers like
120 REM one too: SYSTEM/1 <id> OK, STATE, DISPLAY, LINE, END. There is no
130 REM separate "CALL"/"REPLY" verb pair on this side of the wire; that
140 REM pair belongs to the RESPONSE a *caller* emits mid-turn (2.3) and to
150 REM the RESUME/REPLY the host re-invokes the *caller* with afterward -
160 REM never to the callee, which `emulator/node/app/localcall.py:29`
170 REM confirms: `runner.run(call.peer, "INPUT", store.load(), call.payload)`.
180 REM systems/school-db/ is the pattern this file now matches exactly.
190 REM
200 REM Request:
210 REM   SYSTEM/1 school-ada CONNECT      (greeting; also matches school-db)
220 REM   STATE 0
230 REM   END
240 REM or
250 REM   SYSTEM/1 school-ada INPUT
260 REM   STATE 0
270 REM   INPUT RUN ADAR11
280 REM   END
290 REM
300 REM Response:
310 REM   SYSTEM/1 school-ada OK
320 REM   STATE 0
330 REM   DISPLAY <k>
340 REM   <k lines - the report, see below>
350 REM   LINE UP
360 REM   END
370 REM This program carries no state of its own between turns (it reads
380 REM its data files fresh every invocation), so STATE is always 0 both
390 REM ways.
400 REM
410 REM The INPUT report (k = NB + 2, NB = buildings read off CALEND.DAT):
420 REM   <NB lines: BUILDING ENROLLED ADM ADA, one per building>
430 REM   DISTRICT <ADM> <ADA>
440 REM   ABSENCE POSTINGS NOT ON FILE - CLAIM PROVISIONAL
450 REM
460 REM Field widths - fixed here; Task 5's PRINT job formats from these
470 REM exactly, so they must not move without updating that caller too:
480 REM   BUILDING   7 chars, left-justified, space-padded
490 REM   ENROLLED   5 chars, right-justified integer
500 REM   ADM        7 chars, right-justified, 2 decimals (e.g. " 320.00")
510 REM   ADA        7 chars, right-justified, 2 decimals
520 REM Fields are separated by one space. A building line is therefore
530 REM exactly 7+1+5+1+7+1+7 = 29 characters. The DISTRICT line is the
540 REM literal "DISTRICT" (8 chars) + space + ADM(7) + space + ADA(7) = 24.
550 REM These two lines are unchanged from this program's first cut; only
560 REM the request/response envelope around them was wrong before.
570 REM
580 REM IMPORTANT - read before treating ADA as a bug: ADM and ADA both
590 REM equal raw ENROLLED, exactly, in every row this program can ever
600 REM produce today. That is not an arithmetic error - it is the honest
610 REM consequence of the only two data sources this program has: the
620 REM roster (a headcount) and CALEND.DAT (an instructional-day divisor).
630 REM There is no per-student attendance or absence record anywhere on
640 REM the disk yet; posting one is phase 3's job (design doc section 8,
650 REM "the data" - ENROLL.BAS/REGIST.DAT), not this program's. Owner
660 REM ruling (2026-08-05): phase 2 ships the machinery, not a real claim,
670 REM so this program says so out loud - the trailing "CLAIM PROVISIONAL"
680 REM line above - rather than printing a computed-looking figure that
690 REM is actually just enrollment wearing a decimal point. Once phase 3
700 REM posts real absence data, aggregate days attended will stop being
710 REM identical to aggregate membership days, ADA will diverge from ADM,
720 REM and that trailing line comes out.
730 REM
740 REM The roster (systems/school/data/students.dat) carries no building
750 REM column (see that program's 8500 loader), so its whole headcount is
760 REM attributed to the one building named on CALEND.DAT (today, HIGH).
770 REM A second building would need a roster building column to split the
780 REM headcount correctly - out of scope here, so 4040 below refuses
790 REM rather than silently misreport if CALEND.DAT ever names more than
800 REM one.
900 DIM BN$(10)
910 DIM BD(10)
920 DIM LN$(10)
930 GOSUB 8500
940 GOSUB 8600
1000 REM ---- parse the SYSTEM/1 request from stdin ----
1010 LINE INPUT H$
1020 IF LEFT$(H$, 20) <> "SYSTEM/1 school-ada " THEN GOTO 7000
1030 CMD$ = MID$(H$, 21)
1040 LINE INPUT S$
1050 IF LEFT$(S$, 6) <> "STATE " THEN GOTO 7000
1060 SN = VAL(MID$(S$, 7))
1070 IF SN <> 0 THEN GOTO 7000
1080 REM trailing line: INPUT <request> (INPUT cmd) or END (CONNECT)
1090 LINE INPUT T$
1100 HI = 0
1110 IF LEFT$(T$, 6) <> "INPUT " THEN GOTO 1160
1120 IN$ = MID$(T$, 7)
1130 HI = 1
1140 LINE INPUT E$
1150 IF E$ <> "END" THEN GOTO 7000
1155 GOTO 1200
1160 IF T$ <> "END" THEN GOTO 7000
1200 REM ---- dispatch on command ----
1210 IF CMD$ = "CONNECT" THEN GOTO 3000
1220 IF CMD$ = "INPUT" THEN GOTO 3300
1230 GOTO 7000
3000 REM CONNECT: announce the program and stay up. No password: the bus
3010 REM is not a dialable line, so reaching it is already authorization
3020 REM (matches school-db's own CONNECT).
3030 PRINT "SYSTEM/1 school-ada OK"
3040 PRINT "STATE 0"
3050 PRINT "DISPLAY 1"
3060 PRINT "ADAR11 - STATE ADA CLAIM"
3070 PRINT "LINE UP"
3080 PRINT "END"
3090 END
3300 REM ---- INPUT: the one payload verb this program answers ----
3310 IF HI = 0 THEN GOTO 7000
3320 IF IN$ <> "RUN ADAR11" THEN GOTO 7000
3330 GOTO 4000
4000 REM ---- RUN ADAR11: compute the claim ----
4010 REM defensive: this loop attributes the whole roster to one building;
4020 REM a second one on CALEND.DAT would need a roster building column to
4030 REM split the headcount correctly - see the header note.
4040 IF NB <> 1 THEN GOTO 7000
4050 TM = 0
4060 TT = 0
4070 FOR I = 1 TO NB
4080 ER = NS
4090 MD = ER * BD(I)
4100 TM = TM + MD
4110 TT = TT + BD(I)
4120 N2 = MD / BD(I)
4130 W2 = 7
4140 GOSUB 9200
4150 A1$ = F2$
4160 N2 = MD / BD(I)
4170 GOSUB 9200
4180 A2$ = F2$
4190 T4$ = BN$(I)
4200 W4 = 7
4210 GOSUB 9500
4220 N3 = ER
4230 W3 = 5
4240 GOSUB 9400
4250 LN$(I) = T4$ + " " + I3$ + " " + A1$ + " " + A2$
4260 NEXT I
4270 N2 = TM / TT
4280 W2 = 7
4290 GOSUB 9200
4300 D1$ = F2$
4310 GOSUB 9200
4320 D2$ = F2$
4330 PRINT "SYSTEM/1 school-ada OK"
4340 PRINT "STATE 0"
4350 PRINT "DISPLAY " + MID$(STR$(NB + 2), 2)
4360 FOR I = 1 TO NB
4370 PRINT LN$(I)
4380 NEXT I
4390 PRINT "DISTRICT " + D1$ + " " + D2$
4400 PRINT "ABSENCE POSTINGS NOT ON FILE - CLAIM PROVISIONAL"
4410 PRINT "LINE UP"
4420 PRINT "END"
4430 END
7000 REM ---- malformed request, or a data shape this program cannot yet
7010 REM attribute correctly: refuse loudly rather than misreport ----
7020 PRINT "SYSTEM/1 school-ada OK"
7030 PRINT "STATE 0"
7040 PRINT "DISPLAY 1"
7050 PRINT "PROTOCOL ERROR"
7060 PRINT "LINE DROP"
7070 PRINT "END"
7080 END
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
