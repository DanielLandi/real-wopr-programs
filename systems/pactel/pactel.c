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
 * STATE is line 1 "LINE <10 digits>" -- the line number currently under
 * test -- followed by zero or more "ADJ <10 digits> <amount>" tags, one per
 * billing override recorded against an account (amount like "0.00"). The
 * node is declared "state": "persistent" (PACK.md), so the host owns this
 * STATE block across calls: whatever we emit is fed back to us verbatim on
 * the next CONNECT. CONNECT resets the line under test to DEFAULT_LINE but
 * preserves every parsed ADJ tag -- that is the whole persistence contract.
 * Deterministic throughout: no wall clock, no unseeded randomness. VERIFY
 * status is derived from the line number's last digit (odd -> BUSY, even ->
 * IDLE).
 *
 * Room to grow: billing state is kept as ADJ tags so it could move
 * wholesale into a pactel-db bus store (school/school-db pattern) if
 * billing outgrows the test board.
 */

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LINEBUF 600
#define DEFAULT_LINE "2065550137"
#define MAX_STATE_LINES 48
#define MAX_ACCOUNTS 32
#define MAX_CALLS 64

/* Accounts loaded from data/accounts.dat at spawn. */
static char acct_line[MAX_ACCOUNTS][11];
static char acct_name[MAX_ACCOUNTS][23];
static long acct_cents[MAX_ACCOUNTS];
static int n_accounts = 0;

/* Call records loaded from data/calls.dat at spawn. */
static char call_line[MAX_CALLS][11];
static char call_date[MAX_CALLS][9];
static char call_called[MAX_CALLS][11];
static int call_minutes[MAX_CALLS];
static long call_charge_cents[MAX_CALLS];
static int n_calls = 0;

/* Billing overrides ("ADJ" tags), parsed from incoming STATE and/or set by
   the ADJ command. File-scope so emit_ok can re-emit them into STATE. Cap
   matches MAX_ACCOUNTS: an override only ever exists for an account. */
static char adj_line[MAX_ACCOUNTS][11];
static long adj_cents[MAX_ACCOUNTS];
static int n_adj = 0;

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

/* Parse a billing amount: 1-6 digits, optionally followed by '.' and
   exactly 2 digits ("0", "12.50", "0.00"). On success stores the value as
   cents in *out_cents and returns 1; on any malformed input returns 0. */
static int parse_amount(const char *s, long *out_cents)
{
    const char *dot;
    int intlen;
    char intbuf[8];
    int i;

    dot = strchr(s, '.');
    intlen = (int) (dot != NULL ? dot - s : (long) strlen(s));
    if (intlen < 1 || intlen > 6) {
        return 0;
    }
    for (i = 0; i < intlen; i++) {
        if (!isdigit((unsigned char) s[i])) {
            return 0;
        }
    }
    strncpy(intbuf, s, (size_t) intlen);
    intbuf[intlen] = '\0';

    if (dot == NULL) {
        *out_cents = atol(intbuf) * 100;
        return 1;
    }

    if (!isdigit((unsigned char) dot[1]) || !isdigit((unsigned char) dot[2])
        || dot[3] != '\0') {
        return 0;
    }
    *out_cents = atol(intbuf) * 100 + (dot[1] - '0') * 10 + (dot[2] - '0');
    return 1;
}

/* Format cents as "d.dd" (no leading '$'). out must be >= 16 bytes. */
static void format_cents(char *out, long cents)
{
    sprintf(out, "%ld.%02ld", cents / 100, cents % 100);
}

/* Record (or overwrite) a billing override for line10. Silently drops the
   override once the MAX_ACCOUNTS cap is reached -- these are our own data
   files, so quiet truncation is acceptable. */
static void record_override(const char *line10, long cents)
{
    int i;
    for (i = 0; i < n_adj; i++) {
        if (strcmp(adj_line[i], line10) == 0) {
            adj_cents[i] = cents;
            return;
        }
    }
    if (n_adj < MAX_ACCOUNTS) {
        strcpy(adj_line[n_adj], line10);
        adj_cents[n_adj] = cents;
        n_adj++;
    }
}

/* Look up an override for line10. Returns 1 and sets *cents_out on a hit. */
static int find_override(const char *line10, long *cents_out)
{
    int i;
    for (i = 0; i < n_adj; i++) {
        if (strcmp(adj_line[i], line10) == 0) {
            *cents_out = adj_cents[i];
            return 1;
        }
    }
    return 0;
}

/* Index of line10 in the accounts table, or -1. */
static int find_account(const char *line10)
{
    int i;
    for (i = 0; i < n_accounts; i++) {
        if (strcmp(acct_line[i], line10) == 0) {
            return i;
        }
    }
    return -1;
}

/* Current balance for accounts[idx]: the override if one is recorded for
   that account's line, else the balance loaded from the data file. */
static long balance_for(int idx)
{
    long cents;
    if (find_override(acct_line[idx], &cents)) {
        return cents;
    }
    return acct_cents[idx];
}

/* Load data/accounts.dat: line(10) 1sp name(22, space-padded) balance
   (right-justified, trailing). A missing file leaves n_accounts at 0 -- the
   board still works as a test board with no billing records. */
static void load_accounts(void)
{
    FILE *f;
    char buf[128];
    char *p;
    int j;

    n_accounts = 0;
    f = fopen("data/accounts.dat", "r");
    if (f == NULL) {
        return;
    }
    while (n_accounts < MAX_ACCOUNTS && fgets(buf, (int) sizeof(buf), f) != NULL) {
        long cents;

        rstrip(buf);
        if ((int) strlen(buf) < 33) {
            continue;
        }
        strncpy(acct_line[n_accounts], buf, 10);
        acct_line[n_accounts][10] = '\0';

        strncpy(acct_name[n_accounts], buf + 11, 22);
        acct_name[n_accounts][22] = '\0';
        j = 21;
        while (j >= 0 && acct_name[n_accounts][j] == ' ') {
            acct_name[n_accounts][j] = '\0';
            j--;
        }

        p = buf + 33;
        while (*p == ' ') {
            p++;
        }
        if (!parse_amount(p, &cents)) {
            continue;
        }
        acct_cents[n_accounts] = cents;
        n_accounts++;
    }
    fclose(f);
}

/* Load data/calls.dat: line(10) 1sp date(8) 1sp called(10) 1sp minutes(3,
   right-justified) 1sp charge(right-justified, trailing). A missing file
   leaves n_calls at 0. */
static void load_calls(void)
{
    FILE *f;
    char buf[128];
    char minbuf[4];
    char *p;

    n_calls = 0;
    f = fopen("data/calls.dat", "r");
    if (f == NULL) {
        return;
    }
    while (n_calls < MAX_CALLS && fgets(buf, (int) sizeof(buf), f) != NULL) {
        long cents;

        rstrip(buf);
        if ((int) strlen(buf) < 35) {
            continue;
        }
        strncpy(call_line[n_calls], buf, 10);
        call_line[n_calls][10] = '\0';

        strncpy(call_date[n_calls], buf + 11, 8);
        call_date[n_calls][8] = '\0';

        strncpy(call_called[n_calls], buf + 20, 10);
        call_called[n_calls][10] = '\0';

        strncpy(minbuf, buf + 31, 3);
        minbuf[3] = '\0';
        call_minutes[n_calls] = atoi(minbuf);

        p = buf + 34;
        while (*p == ' ') {
            p++;
        }
        if (!parse_amount(p, &cents)) {
            cents = 0;
        }
        call_charge_cents[n_calls] = cents;

        n_calls++;
    }
    fclose(f);
}

/* Emit a well-formed SYSTEM/1 OK response. STATE is "LINE <state_line>"
   followed by every recorded ADJ override (file-scope n_adj/adj_line/
   adj_cents); DISPLAY is the k lines in "lines"; prompt, when non-NULL, is
   emitted as the PROMPT block (never on a dropped line); LINE is
   line_status ("UP" or "DROP"). */
static void emit_ok(const char *state_line, const char *lines[], int nlines,
    const char *prompt, const char *line_status)
{
    int i;
    printf("SYSTEM/1 pactel OK\n");
    printf("STATE %d\n", 1 + n_adj);
    printf("LINE %s\n", state_line);
    for (i = 0; i < n_adj; i++) {
        char amtbuf[16];
        format_cents(amtbuf, adj_cents[i]);
        printf("ADJ %s %s\n", adj_line[i], amtbuf);
    }
    printf("DISPLAY %d\n", nlines);
    for (i = 0; i < nlines; i++) {
        printf("%s\n", lines[i]);
    }
    if (prompt != NULL) {
        printf("PROMPT %s\n", prompt);
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

    load_accounts();
    load_calls();

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

    /* n opaque state lines. Tags understood: "LINE <10 digits>" sets the
       line under test; "ADJ <10 digits> <amount>" records/overwrites a
       billing override (appended even for an account unknown to
       accounts.dat -- this is our own persisted state, so lenient parsing
       is fine; the live ADJ command is the one that enforces "account must
       exist"). Anything else present is ignored, but a missing line (EOF
       before n lines read) is a protocol error. */
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
        } else if (starts_with(line, "ADJ ")) {
            char *rest2 = line + strlen("ADJ ");
            char *sp2 = strchr(rest2, ' ');
            if (sp2 != NULL && (int) (sp2 - rest2) == 10) {
                char adjline10[16];
                long cents2;
                strncpy(adjline10, rest2, 10);
                adjline10[10] = '\0';
                if (all_digits(adjline10, 10) && parse_amount(sp2 + 1, &cents2)) {
                    record_override(adjline10, cents2);
                }
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
        const char *lines[2];
        lines[0] = "PACIFIC TELEPHONE";
        lines[1] = "AUTOMATIC TEST BOARD - AUTHORIZED USE ONLY";
        emit_ok(DEFAULT_LINE, lines, 2, "TEST:", "UP");
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
            const char *lines[2];
            format_line(formatted, current_line);
            lines[0] = "ANAC - NUMBER READBACK";
            lines[1] = formatted;
            emit_ok(current_line, lines, 2, "TEST:", "UP");
        } else if (strcmp(cmdtok, "MILLIWATT") == 0) {
            const char *lines[2];
            lines[0] = "MILLIWATT TEST";
            lines[1] = "1004 HZ TONE AT 0 DBM";
            emit_ok(current_line, lines, 2, "TEST:", "UP");
        } else if (strcmp(cmdtok, "QT") == 0) {
            const char *lines[1];
            lines[0] = "QUIET TERMINATION - LINE SILENT";
            emit_ok(current_line, lines, 1, "TEST:", "UP");
        } else if (strcmp(cmdtok, "LOOP") == 0) {
            const char *lines[1];
            lines[0] = "LOOPBACK ENGAGED";
            emit_ok(current_line, lines, 1, "TEST:", "UP");
        } else if (strcmp(cmdtok, "RING") == 0 || strcmp(cmdtok, "RINGBACK") == 0) {
            const char *lines[1];
            lines[0] = "RINGBACK - LINE WILL RING";
            emit_ok(current_line, lines, 1, "TEST:", "UP");
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
                const char *lines[2];
                format_line(formatted, newline10);
                lines[0] = "LINE UNDER TEST SET";
                lines[1] = formatted;
                emit_ok(newline10, lines, 2, "TEST:", "UP");
            } else {
                const char *lines[1];
                lines[0] = "?INVALID LINE";
                emit_ok(current_line, lines, 1, "TEST:", "UP");
            }
        } else if (strcmp(cmdtok, "VERIFY") == 0) {
            char formatted[16];
            char linebuf[24];
            char statusbuf[16];
            const char *lines[2];
            int last_digit;

            format_line(formatted, current_line);
            sprintf(linebuf, "LINE %s", formatted);
            last_digit = current_line[strlen(current_line) - 1] - '0';
            sprintf(statusbuf, "STATUS: %s", (last_digit % 2 == 0) ? "IDLE" : "BUSY");
            lines[0] = linebuf;
            lines[1] = statusbuf;
            emit_ok(current_line, lines, 2, "TEST:", "UP");
        } else if (strcmp(cmdtok, "BAL") == 0) {
            int idx = find_account(current_line);
            if (idx >= 0) {
                char formatted[16];
                char linebuf2[32];
                char subbuf[64];
                const char *lines[3];
                long cents = balance_for(idx);

                format_line(formatted, current_line);
                sprintf(linebuf2, "LINE %s", formatted);
                sprintf(subbuf, "SUBSCRIBER: %s  BALANCE DUE $%ld.%02ld",
                    acct_name[idx], cents / 100, cents % 100);
                lines[0] = "BILLING INQUIRY";
                lines[1] = linebuf2;
                lines[2] = subbuf;
                emit_ok(current_line, lines, 3, "TEST:", "UP");
            } else {
                const char *lines[1];
                lines[0] = "NO ACCOUNT ON FILE";
                emit_ok(current_line, lines, 1, "TEST:", "UP");
            }
        } else if (strcmp(cmdtok, "HIST") == 0) {
            char header[32];
            char rowbuf[MAX_CALLS][64];
            const char *lines[MAX_CALLS + 1];
            char formatted[16];
            int nfound = 0;
            int k;

            format_line(formatted, current_line);
            sprintf(header, "CALL HISTORY - %s", formatted);
            lines[0] = header;

            for (k = 0; k < n_calls; k++) {
                if (strcmp(call_line[k], current_line) == 0) {
                    char calledfmt[16];
                    format_line(calledfmt, call_called[k]);
                    sprintf(rowbuf[nfound], "%s %s  %d MIN  $%ld.%02ld",
                        call_date[k], calledfmt, call_minutes[k],
                        call_charge_cents[k] / 100, call_charge_cents[k] % 100);
                    lines[1 + nfound] = rowbuf[nfound];
                    nfound++;
                }
            }

            if (nfound == 0) {
                lines[1] = "NO CALLS ON FILE";
                emit_ok(current_line, lines, 2, "TEST:", "UP");
            } else {
                emit_ok(current_line, lines, 1 + nfound, "TEST:", "UP");
            }
        } else if (strcmp(cmdtok, "ADJ") == 0) {
            int idx = find_account(current_line);
            long cents;

            if (idx < 0) {
                const char *lines[1];
                lines[0] = "NO ACCOUNT ON FILE";
                emit_ok(current_line, lines, 1, "TEST:", "UP");
            } else if (!parse_amount(rest, &cents)) {
                const char *lines[1];
                lines[0] = "?INVALID AMOUNT";
                emit_ok(current_line, lines, 1, "TEST:", "UP");
            } else {
                char formatted[16];
                char linebuf2[48];
                const char *lines[2];

                record_override(current_line, cents);
                format_line(formatted, current_line);
                sprintf(linebuf2, "LINE %s  BALANCE DUE $%ld.%02ld",
                    formatted, cents / 100, cents % 100);
                lines[0] = "BALANCE ADJUSTED";
                lines[1] = linebuf2;
                emit_ok(current_line, lines, 2, "TEST:", "UP");
            }
        } else if (strcmp(cmdtok, "HELP") == 0) {
            const char *lines[4];
            lines[0] = "COMMANDS:";
            lines[1] = "ANAC MILLIWATT QT LOOP RING";
            lines[2] = "VERIFY  LINE <NUM>  HELP  BYE";
            lines[3] = "BILLING: BAL  HIST  ADJ <AMT>";
            emit_ok(current_line, lines, 4, "TEST:", "UP");
        } else if (strcmp(cmdtok, "BYE") == 0) {
            const char *lines[1];
            lines[0] = "TEST BOARD CLEARED.";
            emit_ok(current_line, lines, 1, NULL, "DROP");
        } else {
            const char *lines[1];
            lines[0] = "?TEST NOT RECOGNIZED";
            emit_ok(current_line, lines, 1, "TEST:", "UP");
        }
    }

    return 0;
}
