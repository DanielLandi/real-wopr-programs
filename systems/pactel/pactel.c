/*
 * pactel.c -- PACIFIC TELEPHONE automatic test board.
 *
 * Speaks SYSTEM/1 (docs/systems.md) on stdin/stdout. Hand-written K&R/C89:
 * block comments, declarations before statements, no C99 constructs. This
 * is our interpretation of the internal test board a phreak like David
 * would find on the phone company's own network -- the film names Pacific
 * Telephone but never shows a loginable system.
 *
 * Wire contract:
 *   SYSTEM/1 pactel <CONNECT|INPUT>
 *   STATE <n>
 *   <n opaque state lines>
 *   INPUT <user line>         -- present only when <CMD> is INPUT
 *   END
 * ->
 *   SYSTEM/1 pactel OK
 *   STATE <m>
 *   <m opaque state lines>
 *   DISPLAY <k>
 *   <k teletype lines>
 *   LINE <UP|DROP>
 *   END
 *
 * STATE is always exactly one line: "LINE <10 digits>" -- the line number
 * currently under test. Deterministic throughout: no wall clock, no
 * unseeded randomness. VERIFY status is derived from the line number's
 * last digit (odd -> BUSY, even -> IDLE).
 */

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LINEBUF 600
#define DEFAULT_LINE "2065550137"
#define MAX_STATE_LINES 20

/* Strip a trailing \r and/or \n from a line read by fgets. */
static void rstrip(char *s)
{
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r')) {
        s[n - 1] = '\0';
        n--;
    }
}

static int starts_with(const char *s, const char *prefix)
{
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

/* True iff s is exactly len characters, all decimal digits. */
static int all_digits(const char *s, int len)
{
    int i;
    if ((int) strlen(s) != len) {
        return 0;
    }
    for (i = 0; i < len; i++) {
        if (!isdigit((unsigned char) s[i])) {
            return 0;
        }
    }
    return 1;
}

/* Format a 10-digit line number as "AAA PPP NNNN". out must be >= 13 bytes. */
static void format_line(char *out, const char *digits10)
{
    sprintf(out, "%c%c%c %c%c%c %c%c%c%c",
        digits10[0], digits10[1], digits10[2],
        digits10[3], digits10[4], digits10[5],
        digits10[6], digits10[7], digits10[8], digits10[9]);
}

/* Emit a well-formed SYSTEM/1 OK response. STATE is always the single
   "LINE <state_line>" tag; DISPLAY is the k lines in "lines"; LINE is
   line_status ("UP" or "DROP"). */
static void emit_ok(const char *state_line, const char *lines[], int nlines,
    const char *line_status)
{
    int i;
    printf("SYSTEM/1 pactel OK\n");
    printf("STATE 1\n");
    printf("LINE %s\n", state_line);
    printf("DISPLAY %d\n", nlines);
    for (i = 0; i < nlines; i++) {
        printf("%s\n", lines[i]);
    }
    printf("LINE %s\n", line_status);
    printf("END\n");
}

static void emit_protocol_error(void)
{
    printf("SYSTEM/1 pactel OK\n");
    printf("STATE 1\n");
    printf("LINE %s\n", DEFAULT_LINE);
    printf("DISPLAY 1\n");
    printf("PROTOCOL ERROR\n");
    printf("LINE DROP\n");
    printf("END\n");
}

/* Read one line into buf (size LINEBUF), stripped of its newline. Returns
   0 on success, -1 on EOF/read error. */
static int read_line(char *buf)
{
    if (fgets(buf, LINEBUF, stdin) == NULL) {
        return -1;
    }
    rstrip(buf);
    return 0;
}

int main(void)
{
    char line[LINEBUF];
    char cmd[LINEBUF];
    char input_line[LINEBUF];
    char current_line[16];
    int is_connect;
    int n;
    int i;
    char *p;

    strcpy(current_line, DEFAULT_LINE);
    input_line[0] = '\0';

    /* Line 1: "SYSTEM/1 pactel <CMD>" */
    if (read_line(line) != 0) {
        emit_protocol_error();
        return 1;
    }
    if (!starts_with(line, "SYSTEM/1 pactel ")) {
        emit_protocol_error();
        return 1;
    }
    strcpy(cmd, line + strlen("SYSTEM/1 pactel "));
    if (strcmp(cmd, "CONNECT") == 0) {
        is_connect = 1;
    } else if (strcmp(cmd, "INPUT") == 0) {
        is_connect = 0;
    } else {
        emit_protocol_error();
        return 1;
    }

    /* Line 2: "STATE <n>" */
    if (read_line(line) != 0) {
        emit_protocol_error();
        return 1;
    }
    if (!starts_with(line, "STATE ")) {
        emit_protocol_error();
        return 1;
    }
    p = line + strlen("STATE ");
    if (*p == '\0' || !all_digits(p, (int) strlen(p))) {
        emit_protocol_error();
        return 1;
    }
    n = atoi(p);
    if (n < 0 || n > MAX_STATE_LINES) {
        emit_protocol_error();
        return 1;
    }

    /* n opaque state lines. The only tag this system emits/expects is
       "LINE <10 digits>"; anything else present is ignored, but a missing
       line (EOF before n lines read) is a protocol error. */
    for (i = 0; i < n; i++) {
        if (read_line(line) != 0) {
            emit_protocol_error();
            return 1;
        }
        if (starts_with(line, "LINE ")) {
            p = line + strlen("LINE ");
            if (all_digits(p, 10)) {
                strcpy(current_line, p);
            }
        }
    }

    /* INPUT command carries one "INPUT <user line>" line before END. */
    if (!is_connect) {
        if (read_line(line) != 0) {
            emit_protocol_error();
            return 1;
        }
        if (strcmp(line, "INPUT") == 0) {
            input_line[0] = '\0';
        } else if (starts_with(line, "INPUT ")) {
            strcpy(input_line, line + strlen("INPUT "));
        } else {
            emit_protocol_error();
            return 1;
        }
    }

    /* Terminal "END" line. */
    if (read_line(line) != 0) {
        emit_protocol_error();
        return 1;
    }
    if (strcmp(line, "END") != 0) {
        emit_protocol_error();
        return 1;
    }

    if (is_connect) {
        const char *lines[3];
        lines[0] = "PACIFIC TELEPHONE";
        lines[1] = "AUTOMATIC TEST BOARD - AUTHORIZED USE ONLY";
        lines[2] = "TEST:";
        emit_ok(DEFAULT_LINE, lines, 3, "UP");
        return 0;
    }

    /* INPUT dispatch: split input_line into a command token and the rest. */
    {
        char cmdtok[LINEBUF];
        char rest[LINEBUF];
        char *sp;

        sp = strchr(input_line, ' ');
        if (sp != NULL) {
            int toklen = (int) (sp - input_line);
            strncpy(cmdtok, input_line, toklen);
            cmdtok[toklen] = '\0';
            strcpy(rest, sp + 1);
        } else {
            strcpy(cmdtok, input_line);
            rest[0] = '\0';
        }

        if (strcmp(cmdtok, "ANAC") == 0) {
            char formatted[16];
            const char *lines[3];
            format_line(formatted, current_line);
            lines[0] = "ANAC - NUMBER READBACK";
            lines[1] = formatted;
            lines[2] = "TEST:";
            emit_ok(current_line, lines, 3, "UP");
        } else if (strcmp(cmdtok, "MILLIWATT") == 0) {
            const char *lines[3];
            lines[0] = "MILLIWATT TEST";
            lines[1] = "1004 HZ TONE AT 0 DBM";
            lines[2] = "TEST:";
            emit_ok(current_line, lines, 3, "UP");
        } else if (strcmp(cmdtok, "QT") == 0) {
            const char *lines[2];
            lines[0] = "QUIET TERMINATION - LINE SILENT";
            lines[1] = "TEST:";
            emit_ok(current_line, lines, 2, "UP");
        } else if (strcmp(cmdtok, "LOOP") == 0) {
            const char *lines[2];
            lines[0] = "LOOPBACK ENGAGED";
            lines[1] = "TEST:";
            emit_ok(current_line, lines, 2, "UP");
        } else if (strcmp(cmdtok, "RING") == 0 || strcmp(cmdtok, "RINGBACK") == 0) {
            const char *lines[2];
            lines[0] = "RINGBACK - LINE WILL RING";
            lines[1] = "TEST:";
            emit_ok(current_line, lines, 2, "UP");
        } else if (strcmp(cmdtok, "LINE") == 0) {
            int restlen = (int) strlen(rest);
            char newline10[16];
            int valid = 0;

            if (restlen == 10 && all_digits(rest, 10)) {
                strcpy(newline10, rest);
                valid = 1;
            } else if (restlen == 7 && all_digits(rest, 7)) {
                sprintf(newline10, "206%s", rest);
                valid = 1;
            }

            if (valid) {
                char formatted[16];
                const char *lines[3];
                format_line(formatted, newline10);
                lines[0] = "LINE UNDER TEST SET";
                lines[1] = formatted;
                lines[2] = "TEST:";
                emit_ok(newline10, lines, 3, "UP");
            } else {
                const char *lines[2];
                lines[0] = "?INVALID LINE";
                lines[1] = "TEST:";
                emit_ok(current_line, lines, 2, "UP");
            }
        } else if (strcmp(cmdtok, "VERIFY") == 0) {
            char formatted[16];
            char linebuf[24];
            char statusbuf[16];
            const char *lines[3];
            int last_digit;

            format_line(formatted, current_line);
            sprintf(linebuf, "LINE %s", formatted);
            last_digit = current_line[strlen(current_line) - 1] - '0';
            sprintf(statusbuf, "STATUS: %s", (last_digit % 2 == 0) ? "IDLE" : "BUSY");
            lines[0] = linebuf;
            lines[1] = statusbuf;
            lines[2] = "TEST:";
            emit_ok(current_line, lines, 3, "UP");
        } else if (strcmp(cmdtok, "HELP") == 0) {
            const char *lines[4];
            lines[0] = "COMMANDS:";
            lines[1] = "ANAC MILLIWATT QT LOOP RING";
            lines[2] = "VERIFY  LINE <NUM>  HELP  BYE";
            lines[3] = "TEST:";
            emit_ok(current_line, lines, 4, "UP");
        } else if (strcmp(cmdtok, "BYE") == 0) {
            const char *lines[1];
            lines[0] = "TEST BOARD CLEARED.";
            emit_ok(current_line, lines, 1, "DROP");
        } else {
            const char *lines[2];
            lines[0] = "?TEST NOT RECOGNIZED";
            lines[1] = "TEST:";
            emit_ok(current_line, lines, 2, "UP");
        }
    }

    return 0;
}
