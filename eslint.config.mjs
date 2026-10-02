import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["dist/**", "node_modules/**", "tests/**"]
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"]
        }
      }
    },
    rules: {
      // Keep the imperative settings API compatible with the declared Obsidian 0.15 minimum.
      "obsidianmd/settings-tab/prefer-setting-definitions": "off"
    }
  }
]);