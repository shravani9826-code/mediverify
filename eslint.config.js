import js from '@eslint/js';
import globals from 'globals';
import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*']
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: ['firestore.rules'],
    plugins: {
      'firebase-rules': firebaseRulesPlugin
    },
    rules: {
      ...firebaseRulesPlugin.configs['flat/recommended'].rules
    }
  }
];
