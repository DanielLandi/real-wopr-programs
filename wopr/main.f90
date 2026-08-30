! ====================================================================
! W.O.P.R. EXECUTIVE -- SKELETON (phase 2 spawn-cost measurement)
!
! War Operation Plan Response.  This is the connection monitor: the
! program that owns a terminal session and decides what the terminal is
! attached to.  At this commit it is a SKELETON -- it parses a SYSTEM/1
! request frame and writes a well-formed SYSTEM/1 response, and nothing
! more.  It exists so the spawn cost of putting a subprocess on every
! terminal turn can be measured BEFORE any logic is written into it (the
! executive design spec, "Risks and accepted changes").
!
! Period discipline: F77/F90 constructs only -- fixed character
! buffers, DO loops, SELECT CASE, internal procedures.  Same rules as
! the games (CONTRIBUTING.md).
! ====================================================================
program wopr
   implicit none

   integer, parameter :: MAXLINE = 1024
   integer, parameter :: MAXST   = 64

   character(len=MAXLINE) :: verb
   character(len=MAXLINE) :: userin
   character(len=MAXLINE) :: state(MAXST)
   integer :: nstate

   call read_request(verb, userin, state, nstate)
   call write_response(state, nstate)

contains

   ! ---------------------------------------------------------------
   ! Read one SYSTEM/1 request frame from standard input.
   !
   !   SYSTEM/1 wopr <CONNECT|INPUT>
   !   STATE <n>
   !   <n state lines>
   !   INPUT <text>          (optional)
   !   FACTS <n>             (optional) <n fact lines>
   !   REPLY <peer> <st> <n> (optional) <n payload lines>
   !   END
   !
   ! The skeleton keeps the verb, the input line and the state block,
   ! and reads past everything else.  A malformed frame is a protocol
   ! error: a well-formed ERROR display and a non-zero exit.
   ! ---------------------------------------------------------------
   subroutine read_request(cmd, uin, st, nst)
      character(len=*), intent(out) :: cmd
      character(len=*), intent(out) :: uin
      character(len=*), intent(out) :: st(MAXST)
      integer, intent(out) :: nst

      character(len=MAXLINE) :: line
      integer :: ios, n, i

      cmd = ' '
      uin = ' '
      nst = 0

      read(*, '(A)', iostat=ios) line
      if (ios /= 0) call protocol_error('EMPTY REQUEST')
      if (line(1:9) /= 'SYSTEM/1 ') call protocol_error('BAD HEADER')
      cmd = field(line, 3)

      read(*, '(A)', iostat=ios) line
      if (ios /= 0) call protocol_error('MISSING STATE')
      if (line(1:6) /= 'STATE ') call protocol_error('MISSING STATE')
      n = to_int(field(line, 2))
      if (n < 0 .or. n > MAXST) call protocol_error('STATE TOO LARGE')
      nst = n
      do i = 1, n
         read(*, '(A)', iostat=ios) st(i)
         if (ios /= 0) call protocol_error('SHORT STATE BLOCK')
      end do

      do
         read(*, '(A)', iostat=ios) line
         if (ios /= 0) call protocol_error('MISSING END')
         if (trim(line) == 'END') exit
         if (line(1:6) == 'INPUT ') then
            uin = line(7:)
         else if (line(1:6) == 'FACTS ') then
            call skip_block(to_int(field(line, 2)))
         else if (line(1:6) == 'REPLY ') then
            call skip_block(to_int(field(line, 4)))
         end if
      end do
   end subroutine read_request

   subroutine skip_block(n)
      integer, intent(in) :: n
      character(len=MAXLINE) :: line
      integer :: i, ios
      do i = 1, n
         read(*, '(A)', iostat=ios) line
         if (ios /= 0) call protocol_error('SHORT BLOCK')
      end do
   end subroutine skip_block

   ! ---------------------------------------------------------------
   ! Write one SYSTEM/1 response frame.  The skeleton echoes the state
   ! it was handed and prints a single line, which is enough to make
   ! the round trip real: a spawn, a frame in, a frame out, an exit.
   ! ---------------------------------------------------------------
   subroutine write_response(st, nst)
      character(len=*), intent(in) :: st(MAXST)
      integer, intent(in) :: nst
      integer :: i

      write(*, '(A)') 'SYSTEM/1 wopr OK'
      write(*, '(A,I0)') 'STATE ', nst
      do i = 1, nst
         write(*, '(A)') trim(st(i))
      end do
      write(*, '(A)') 'DISPLAY 1'
      write(*, '(A)') 'LOGON:'
      write(*, '(A)') 'LINE UP'
      write(*, '(A)') 'END'
   end subroutine write_response

   subroutine protocol_error(why)
      character(len=*), intent(in) :: why
      write(*, '(A)') 'SYSTEM/1 wopr OK'
      write(*, '(A)') 'STATE 0'
      write(*, '(A)') 'DISPLAY 1'
      write(*, '(A)') 'PROTOCOL ERROR: '//trim(why)
      write(*, '(A)') 'LINE DROP'
      write(*, '(A)') 'END'
      stop 1
   end subroutine protocol_error

   ! The n-th blank-delimited field of a line, blank if absent.
   function field(line, n) result(out)
      character(len=*), intent(in) :: line
      integer, intent(in) :: n
      character(len=MAXLINE) :: out
      character(len=MAXLINE) :: rest
      integer :: k, i

      rest = adjustl(line)
      out = ' '
      do i = 1, n
         k = index(trim(rest), ' ')
         if (k == 0) then
            out = rest
            if (i < n) out = ' '
            return
         end if
         out = rest(1:k-1)
         rest = adjustl(rest(k+1:))
      end do
   end function field

   function to_int(s) result(v)
      character(len=*), intent(in) :: s
      integer :: v, ios
      read(s, *, iostat=ios) v
      if (ios /= 0) v = -1
   end function to_int

end program wopr
