import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'child_process';
import { getCurrentBranch, runGit, tryGit } from '../gitUtils.js';

function parseRecentCommits(logOutput) {
  return String(logOutput)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const firstSpace = line.indexOf(' ');
      if (firstSpace === -1) {
        return null;
      }
      const sha = line.slice(0, firstSpace).trim();
      const subject = line.slice(firstSpace + 1).trim();
      if (!sha) {
        return null;
      }
      return { sha, subject };
    })
    .filter(Boolean);
}

function isCherryPickInProgress() {
  const result = tryGit(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']);
  return result.success;
}

function normalizeCommits(commits) {
  return Array.from(new Set(commits.map(c => String(c).trim()).filter(Boolean)));
}

function findInvalidCommits(commits) {
  const invalid = [];
  for (const commit of commits) {
    const exists = tryGit(['cat-file', '-e', `${commit}^{commit}`]);
    if (!exists.success) {
      invalid.push(commit);
    }
  }
  return invalid;
}

async function promptCherryPickAction() {
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'A cherry-pick is in progress. What would you like to do?',
      choices: [
        { name: 'Continue (after resolving conflicts and staging)', value: 'continue' },
        { name: 'Skip current commit', value: 'skip' },
        { name: 'Abort cherry-pick', value: 'abort' },
        { name: 'Show git status', value: 'status' },
        { name: 'Exit', value: 'exit' }
      ]
    }
  ]);

  return action;
}

async function promptCommitSelection() {
  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'How do you want to choose commits to cherry-pick?',
      choices: [
        { name: 'Select from recent commits', value: 'recent' },
        { name: 'Paste commit hashes / ranges', value: 'paste' },
        { name: 'Cancel', value: 'cancel' }
      ]
    }
  ]);

  if (mode === 'cancel') {
    return [];
  }

  if (mode === 'paste') {
    const { input } = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: 'Enter commit hash(es) or a range (space-separated):'
      }
    ]);
    return String(input || '')
      .split(/\s+/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  const rawLog = runGit(['log', '--oneline', '--decorate', '--all', '-n', '30']);
  const recent = parseRecentCommits(rawLog);

  if (recent.length === 0) {
    console.log(chalk.yellow('No recent commits found.'));
    return [];
  }

  const { selected } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Select commit(s) to cherry-pick (order shown is newest first):',
      choices: recent.map(item => ({
        name: `${item.sha} ${item.subject}`,
        value: item.sha
      }))
    }
  ]);

  return selected || [];
}

function runGitStatus() {
  execSync('git status', { stdio: 'inherit' });
}

function buildCherryPickArgs(options) {
  const args = ['cherry-pick'];
  if (options?.mainline) {
    args.push('-m', String(options.mainline));
  }
  if (options?.noCommit === true) {
    args.push('--no-commit');
  }
  if (options?.signoff === true) {
    args.push('--signoff');
  }
  return args;
}

async function handleCherryPickStateAction(action) {
  if (action === 'status') {
    runGitStatus();
    return;
  }

  if (action === 'exit') {
    console.log(chalk.yellow('Exiting cherry-pick helper.'));
    return;
  }

  const args = ['cherry-pick', `--${action}`];
  const spinner = ora(`Running git ${args.join(' ')}...`).start();
  try {
    runGit(args);
    spinner.succeed(`git ${args.join(' ')} completed.`);
  } catch (error) {
    spinner.fail(`git ${args.join(' ')} failed.`);
    console.error(error.message);
  }

  if (isCherryPickInProgress()) {
    console.log(chalk.yellow('\nCherry-pick still in progress. Resolve conflicts, stage files, then run:'));
    console.log(chalk.cyan('  gitguide cherry-pick --continue'));
  }
}

export async function cherryPickCommand(commits = [], options = {}) {
  if (options.continue) {
    await handleCherryPickStateAction('continue');
    return;
  }

  if (options.abort) {
    await handleCherryPickStateAction('abort');
    return;
  }

  if (options.skip) {
    await handleCherryPickStateAction('skip');
    return;
  }

  if (isCherryPickInProgress()) {
    const action = await promptCherryPickAction();
    await handleCherryPickStateAction(action);
    return;
  }

  let selectedCommits = Array.isArray(commits) ? commits : [commits];
  if (selectedCommits.length === 0 || options.interactive) {
    selectedCommits = await promptCommitSelection();
  }

  const validatedCommits = normalizeCommits(selectedCommits);
  if (validatedCommits.length === 0) {
    console.log(chalk.yellow('No commits selected.'));
    return;
  }

  const invalid = findInvalidCommits(validatedCommits);

  if (invalid.length > 0) {
    console.log(chalk.red('These commits could not be found:'));
    invalid.forEach(c => console.log(chalk.white(`- ${c}`)));
    return;
  }

  const branch = getCurrentBranch() || '(unknown branch)';
  console.log(chalk.bold.blue(`\nCherry-pick target branch: ${branch}`));
  validatedCommits.forEach((c, i) => console.log(chalk.white(`${i + 1}. ${c}`)));

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Proceed with cherry-pick?',
      default: false
    }
  ]);

  if (!confirm) {
    console.log(chalk.yellow('Cherry-pick cancelled.'));
    return;
  }

  const baseArgs = buildCherryPickArgs(options);
  for (const commit of validatedCommits) {
    const spinner = ora(`Cherry-picking ${commit}...`).start();
    try {
      runGit([...baseArgs, commit]);
      spinner.succeed(`Cherry-picked ${commit}.`);
    } catch (error) {
      spinner.fail(`Cherry-pick failed for ${commit}.`);
      console.error(error.message);
      if (isCherryPickInProgress()) {
        console.log(chalk.yellow('\nConflicts detected. Resolve them, stage your changes, then run one of:'));
        console.log(chalk.cyan('  gitguide cherry-pick --continue'));
        console.log(chalk.cyan('  gitguide cherry-pick --skip'));
        console.log(chalk.cyan('  gitguide cherry-pick --abort'));
        runGitStatus();
        return;
      }
      return;
    }
  }

  console.log(chalk.green(`\nCherry-pick complete. Applied ${validatedCommits.length} commit(s) onto ${branch}.`));
}

export const __testing = {
  parseRecentCommits,
  normalizeCommits,
  isCherryPickInProgress
};
