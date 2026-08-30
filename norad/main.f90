! ====================================================================
! NORAD OPERATIONS -- the operator console
!
! SKELETON. This parses a SYSTEM/1 request frame -- header, STATE,
! INPUT, FACTS, REPLY -- and writes a well-formed response, and decides
! nothing. It exists so the cost of a console turn can be measured
! before any logic is written into it (tools/bench-executive.py).
! ====================================================================
program norad
   implicit none

   integer, parameter :: LL    = 1024   ! one card image
   integer, parameter :: MAXST = 64     ! STATE lines in or out
   integer, parameter :: MAXFC = 64     ! FACTS lines
   integer, parameter :: MAXRP = 400    ! REPLY payload lines
   integer, parameter :: MAXOU = 64     ! DISPLAY lines out

   character(len=LL) :: rq_input
   logical           :: rq_has_input
   character(len=LL) :: rp_peer, rp_status
   integer           :: rp_n
   character(len=LL) :: rp_line(MAXRP)
   logical           :: rq_has_reply

   integer           :: n_out
   character(len=LL) :: out_line(MAXOU)

   character(len=*), parameter :: UNRECOGNIZED_DIRECTIVE = 'UNRECOGNIZED DIRECTIVE'

   call main()

contains

   subroutine main()
      n_out = 0
      call read_request()
      call emit(UNRECOGNIZED_DIRECTIVE)
      call write_response()
   end subroutine main

   subroutine read_request()
      character(len=LL) :: line
      integer :: ios, n, i

      rq_input = ' '
      rq_has_input = .false.
      rq_has_reply = .false.
      rp_peer = '-'
      rp_status = '-'
      rp_n = 0

      read(*, '(A)', iostat=ios) line
      if (ios /= 0) call protocol_error('EMPTY REQUEST')
      if (line(1:9) /= 'SYSTEM/1 ') call protocol_error('BAD HEADER')
      if (trim(word(line, 2)) /= 'norad') call protocol_error('WRONG PROGRAM')

      read(*, '(A)', iostat=ios) line
      if (ios /= 0) call protocol_error('MISSING STATE')
      if (line(1:6) /= 'STATE ') call protocol_error('MISSING STATE')
      n = to_int(word(line, 2))
      if (n < 0 .or. n > MAXST) call protocol_error('STATE OUT OF RANGE')
      do i = 1, n
         read(*, '(A)', iostat=ios) line
         if (ios /= 0) call protocol_error('SHORT STATE BLOCK')
      end do

      do
         read(*, '(A)', iostat=ios) line
         if (ios /= 0) call protocol_error('MISSING END')
         if (trim(line) == 'END') exit
         if (line(1:6) == 'INPUT ') then
            rq_input = line(7:)
            rq_has_input = .true.
         else if (trim(line) == 'INPUT') then
            rq_input = ' '
            rq_has_input = .true.
         else if (line(1:6) == 'FACTS ') then
            n = to_int(word(line, 2))
            if (n < 0 .or. n > MAXFC) call protocol_error('FACTS OUT OF RANGE')
            do i = 1, n
               read(*, '(A)', iostat=ios) line
               if (ios /= 0) call protocol_error('SHORT FACTS BLOCK')
            end do
         else if (line(1:6) == 'REPLY ') then
            rp_peer = word(line, 2)
            rp_status = word(line, 3)
            rp_n = to_int(word(line, 4))
            if (rp_n < 0 .or. rp_n > MAXRP) call protocol_error('REPLY OUT OF RANGE')
            do i = 1, rp_n
               read(*, '(A)', iostat=ios) rp_line(i)
               if (ios /= 0) call protocol_error('SHORT REPLY BLOCK')
            end do
            rq_has_reply = .true.
         end if
      end do
   end subroutine read_request

   subroutine emit(text)
      character(len=*), intent(in) :: text
      if (n_out >= MAXOU) return
      n_out = n_out + 1
      out_line(n_out) = text
   end subroutine emit

   subroutine write_response()
      integer :: i
      write(*, '(A)') 'SYSTEM/1 norad OK'
      write(*, '(A)') 'STATE 0'
      write(*, '(A,I0)') 'DISPLAY ', n_out
      do i = 1, n_out
         write(*, '(A)') trim(out_line(i))
      end do
      write(*, '(A)') 'LINE UP'
      write(*, '(A)') 'END'
   end subroutine write_response

   subroutine protocol_error(why)
      character(len=*), intent(in) :: why
      write(*, '(A)') 'SYSTEM/1 norad OK'
      write(*, '(A)') 'STATE 0'
      write(*, '(A)') 'DISPLAY 1'
      write(*, '(A)') 'PROTOCOL ERROR: '//trim(why)
      write(*, '(A)') 'LINE DROP'
      write(*, '(A)') 'END'
      stop 1
   end subroutine protocol_error

   ! The n-th blank-delimited word of a line, blank when absent.
   function word(line, n) result(out)
      character(len=*), intent(in) :: line
      integer, intent(in) :: n
      character(len=LL) :: out, buf
      integer :: k, i

      buf = adjustl(line)
      out = ' '
      do i = 1, n
         if (len_trim(buf) == 0) then
            out = ' '
            return
         end if
         k = index(trim(buf), ' ')
         if (k == 0) then
            if (i == n) then
               out = buf
            else
               out = ' '
            end if
            return
         end if
         out = buf(1:k-1)
         buf = adjustl(buf(k+1:))
      end do
   end function word

   function to_int(s) result(v)
      character(len=*), intent(in) :: s
      integer :: v, ios
      if (len_trim(s) == 0) then
         v = 0
         return
      end if
      read(s, *, iostat=ios) v
      if (ios /= 0) v = 0
   end function to_int

end program norad
