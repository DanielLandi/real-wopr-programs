10 REM GOOSE LAKE UNIFIED SCHOOL DISTRICT - SYSTEM/1 school-db
20 REM The district's student records, held apart from the administrative
30 REM datanet that reads them. The school calls this program over the
40 REM local bus; no subscriber line reaches it. Stateless per invocation:
50 REM grade overrides ride the opaque STATE block, echoed back each turn
60 REM per docs/systems.md. No wall clock and no rng, so same request
70 REM bytes give the same response.
80 REM Verbs: LOOKUP GRADE <id> <course> | SET GRADE <id> <course> <grade>
82 DIM NM$(10)
84 DIM CO(40)
86 DIM CN$(40)
88 DIM CB$(40)
90 DIM GS$(40)
92 DIM GC$(40)
94 DIM GG$(40)
96 GOSUB 8500
100 REM ---- parse the SYSTEM/1 request from stdin ----
110 LINE INPUT H$
120 IF LEFT$(H$, 19) <> "SYSTEM/1 school-db " THEN GOTO 7000
130 CMD$ = MID$(H$, 20)
140 LINE INPUT S$
150 IF LEFT$(S$, 6) <> "STATE " THEN GOTO 7000
160 SN = VAL(MID$(S$, 7))
200 REM resting-store defaults; overwritten by parsed STATE lines
210 NG = 0
270 IF SN <= 0 THEN GOTO 400
280 FOR I = 1 TO SN
290 LINE INPUT L$
300 GOSUB 6000
310 NEXT I
400 REM trailing line: INPUT <request> (INPUT cmd) or END (CONNECT)
410 LINE INPUT T$
420 HI = 0
430 IF LEFT$(T$, 6) <> "INPUT " THEN GOTO 500
440 IN$ = MID$(T$, 7)
450 HI = 1
460 LINE INPUT E$
470 IF E$ <> "END" THEN GOTO 7000
480 GOTO 600
500 IF T$ <> "END" THEN GOTO 7000
600 REM ---- dispatch on command ----
610 IF CMD$ = "CONNECT" THEN GOTO 3000
620 IF CMD$ = "INPUT" THEN GOTO 3300
630 GOTO 7000
3000 REM CONNECT: announce the store and stay up. No password: the bus is
3010 REM not a dialable line, so reaching it is already authorization.
3020 PRINT "SYSTEM/1 school-db OK"
3030 GOSUB 7500
3040 PRINT "DISPLAY 2"
3050 PRINT "GOOSE LAKE STUDENT RECORDS"
3060 PRINT "READY"
3070 PRINT "LINE UP"
3080 PRINT "END"
3090 END
3300 REM INPUT: an INPUT command must carry a request line
3310 IF HI = 0 THEN GOTO 7000
3320 IF LEFT$(IN$, 13) = "LOOKUP GRADE " THEN GOTO 3400
3330 IF LEFT$(IN$, 10) = "SET GRADE " THEN GOTO 3600
3340 GOTO 7000
3400 REM LOOKUP GRADE <id> <course>
3410 R$ = MID$(IN$, 14)
3420 GOSUB 6600
3430 IF QI = 0 THEN GOTO 7000
3440 GOSUB 6800
3450 IF FG$ = "-" THEN GOTO 5000
3460 PRINT "SYSTEM/1 school-db OK"
3470 GOSUB 7500
3480 PRINT "DISPLAY 1"
3490 PRINT "GRADE " + FG$
3500 PRINT "LINE UP"
3510 PRINT "END"
3520 END
3600 REM SET GRADE <id> <course> <grade>
3610 R$ = MID$(IN$, 11)
3620 LP = 0
3630 FOR K = 1 TO LEN(R$)
3640 IF MID$(R$, K, 1) = " " THEN LP = K
3650 NEXT K
3660 IF LP = 0 THEN GOTO 7000
3670 NV$ = MID$(R$, LP + 1)
3680 R$ = LEFT$(R$, LP - 1)
3690 GOSUB 6600
3700 IF QI = 0 THEN GOTO 7000
3710 GOSUB 6900
3720 PRINT "SYSTEM/1 school-db OK"
3730 GOSUB 7500
3740 PRINT "DISPLAY 1"
3750 PRINT "RECORDED"
3760 PRINT "LINE UP"
3770 PRINT "END"
3780 END
5000 REM no such student/course pairing: a clean answer, not an error.
5010 REM A missing record is ordinary; only a malformed request is a fault.
5020 PRINT "SYSTEM/1 school-db OK"
5030 GOSUB 7500
5040 PRINT "DISPLAY 1"
5050 PRINT "NO RECORD"
5060 PRINT "LINE UP"
5070 PRINT "END"
5080 END
6000 REM ---- parse one opaque STATE line in L$ ----
6010 IF LEFT$(L$, 4) = "GRD " THEN GOSUB 6100
6020 RETURN
6100 REM parse "GRD <id> <course...> <grade>" into the override arrays
6110 R2$ = MID$(L$, 5)
6120 SP1 = INSTR(R2$, " ")
6130 IF SP1 = 0 THEN RETURN
6140 GID$ = LEFT$(R2$, SP1 - 1)
6150 R3$ = MID$(R2$, SP1 + 1)
6160 LP = 0
6170 FOR K = 1 TO LEN(R3$)
6180 IF MID$(R3$, K, 1) = " " THEN LP = K
6190 NEXT K
6200 IF LP = 0 THEN RETURN
6210 NG = NG + 1
6220 GS$(NG) = GID$
6230 GC$(NG) = LEFT$(R3$, LP - 1)
6240 GG$(NG) = MID$(R3$, LP + 1)
6250 RETURN
6600 REM split R$ into student id QI and course QC$; QI = 0 if malformed
6610 QI = 0
6620 SP2 = INSTR(R$, " ")
6630 IF SP2 = 0 THEN RETURN
6640 QS$ = LEFT$(R$, SP2 - 1)
6650 QC$ = MID$(R$, SP2 + 1)
6660 QI = VAL(QS$)
6670 IF QI < 1 THEN QI = 0
6680 IF QI > NS THEN QI = 0
6690 RETURN
6800 REM resolve (QI, QC$) to FG$ - an override wins over the base table.
6810 REM FG$ = "-" when the pairing does not exist at all.
6820 FG$ = "-"
6830 FOR K = 1 TO TC
6840 IF CO(K) <> QI THEN GOTO 6860
6850 IF CN$(K) = QC$ THEN FG$ = CB$(K)
6860 NEXT K
6870 IF NG <= 0 THEN RETURN
6880 FOR K = 1 TO NG
6890 IF GS$(K) = MID$(STR$(QI), 2) THEN IF GC$(K) = QC$ THEN FG$ = GG$(K)
6895 NEXT K
6899 RETURN
6900 REM record NV$ as the override for (QI, QC$), replacing any prior one
6910 IF NG <= 0 THEN GOTO 6960
6920 FOR K = 1 TO NG
6930 IF GS$(K) = MID$(STR$(QI), 2) THEN IF GC$(K) = QC$ THEN GG$(K) = NV$ : RETURN
6940 NEXT K
6960 NG = NG + 1
6970 GS$(NG) = MID$(STR$(QI), 2)
6980 GC$(NG) = QC$
6990 GG$(NG) = NV$
6995 RETURN
7000 REM protocol error: fixed drop response (wrapper exits non-zero)
7010 PRINT "SYSTEM/1 school-db OK"
7020 PRINT "STATE 0"
7040 PRINT "DISPLAY 1"
7050 PRINT "PROTOCOL ERROR"
7060 PRINT "LINE DROP"
7070 PRINT "END"
7080 END
7500 REM ---- emit the STATE block: the overrides are the whole store state ----
7510 PRINT "STATE " + MID$(STR$(NG), 2)
7520 IF NG <= 0 THEN RETURN
7530 FOR GI = 1 TO NG
7540 PRINT "GRD " + GS$(GI) + " " + GC$(GI) + " " + GG$(GI)
7550 NEXT GI
7560 RETURN
8500 REM ---- student roster and course/grade tables (canonical) ----
8510 NS = 2
8520 NM$(1) = "LIGHTMAN, DAVID L."
8530 NM$(2) = "MACK, JENNIFER K."
8560 TC = 8
8570 CO(1) = 1
8572 CN$(1) = "BIOLOGY 2"
8574 CB$(1) = "F"
8580 CO(2) = 1
8582 CN$(2) = "ENGLISH 11"
8584 CB$(2) = "D"
8590 CO(3) = 1
8592 CN$(3) = "GEOMETRY"
8594 CB$(3) = "C"
8600 CO(4) = 1
8602 CN$(4) = "COMPUTER LAB"
8604 CB$(4) = "A"
8610 CO(5) = 2
8612 CN$(5) = "BIOLOGY 2"
8614 CB$(5) = "F"
8620 CO(6) = 2
8622 CN$(6) = "ENGLISH 11"
8624 CB$(6) = "B"
8630 CO(7) = 2
8632 CN$(7) = "ALGEBRA 2"
8634 CB$(7) = "C"
8640 CO(8) = 2
8642 CN$(8) = "PHYS ED"
8644 CB$(8) = "A"
8650 RETURN
