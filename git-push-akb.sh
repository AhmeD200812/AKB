#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

branch="${1:-}"
commit_message="${2:-}"

if [[ -z "$branch" ]]; then
  read -r -p "Branch name to push: " branch
fi

if [[ -z "$branch" ]]; then
  echo "Branch name is required."
  exit 1
fi

if ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
  echo "Invalid branch name: $branch"
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Remote 'origin' is not set."
  echo "Set it with:"
  echo "  git remote add origin https://github.com/AhmeD200812/AKB.git"
  exit 1
fi

echo "Fetching origin..."
git fetch origin --prune

current_branch="$(git branch --show-current)"

if [[ "$current_branch" != "$branch" ]]; then
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    echo "Switching to existing local branch: $branch"
    git switch "$branch"
  elif git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    echo "Creating local branch tracking origin/$branch"
    git switch --track "origin/$branch"
  else
    echo "Creating new branch: $branch"
    git switch -c "$branch"
  fi
fi

if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  echo "Updating from origin/$branch..."
  git pull --rebase --autostash origin "$branch"
fi

echo "Staging changes..."
git add -A

if git diff --cached --quiet; then
  echo "No changes to commit."
else
  if [[ -z "$commit_message" ]]; then
    default_message="Update AKB $(date +%Y-%m-%d)"
    read -r -p "Commit message [$default_message]: " commit_message
    commit_message="${commit_message:-$default_message}"
  fi
  echo "Committing changes..."
  git commit -m "$commit_message"
fi

echo "Pushing to origin/$branch..."
if git push -u origin "$branch"; then
  echo "Push complete: $branch"
else
  echo "Push was rejected. Rebasing latest origin/$branch and retrying..."
  git pull --rebase --autostash origin "$branch"
  git push -u origin "$branch"
  echo "Push complete after rebase: $branch"
fi
