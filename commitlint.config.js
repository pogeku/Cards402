export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore', 'ci', 'build', 'revert']],
    'scope-enum': [2, 'always', ['backend', 'web', 'sdk', 'infra', 'deps', 'ci']],
    'subject-max-length': [2, 'always', 72],
  },
};
