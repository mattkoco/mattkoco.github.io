# ~/.bashrc: sourced by the shell at login. Edits here are real:
# try `alias`, or change PS1 and watch the prompt.

PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '

export PATH="$HOME/bin:$PATH"
export EDITOR=code

alias ls='ls --color=auto'
alias ll='ls -lh'
alias la='ls -A'
alias grep='grep --color=auto'
alias ..='cd ..'
alias resume='cat ~/about.txt ~/education.txt ~/experience/*.md ~/achievements.txt'
