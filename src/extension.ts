import * as vscode from 'vscode';
import { ESLint, Linter } from 'eslint';

// Use `require` so it works in a CommonJS environment.
const fetch = require('node-fetch');

// Create a global diagnostic collection
let diagnosticCollection: vscode.DiagnosticCollection;

// Called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  // Initialize the DiagnosticCollection
  diagnosticCollection = vscode.languages.createDiagnosticCollection('react-a11y-ai');
  context.subscriptions.push(diagnosticCollection);

  // Register the main command to run accessibility checks
  const runCheckDisposable = vscode.commands.registerCommand('react-a11y-ai.runCheck', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder found!');
      return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const results = await runA11yChecksOnWorkspace(workspacePath);

    // Show the ESLint-based results as diagnostics
    showA11yDiagnostics(results);
  });
  context.subscriptions.push(runCheckDisposable);

  // Register the command that applies an AI-based fix
  const fixWithAIDisposable = vscode.commands.registerCommand('react-a11y-ai.fixWithAI', fixWithAI);
  context.subscriptions.push(fixWithAIDisposable);

  // Register the Code Action Provider for Quick Fix
  // This example sets it up for JavaScript & TypeScript React files (JSX/TSX).
  const codeActionProvider = new A11yCodeActionProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [
        { language: 'javascriptreact', scheme: 'file' },
        { language: 'typescriptreact', scheme: 'file' }
      ],
      codeActionProvider,
      { providedCodeActionKinds: A11yCodeActionProvider.providedCodeActionKinds }
    )
  );
}

// Called when your extension is deactivated
export function deactivate() {
  // Cleanup if needed
}

/**
 * Runs ESLint with the JSX A11y plugin on the workspace to identify accessibility issues.
 */
async function runA11yChecksOnWorkspace(workspacePath: string) {
  const eslint = new ESLint({
    // Cast to Linter.Config so we can use the 'extends' property
    overrideConfig: {
      extends: ['plugin:jsx-a11y/recommended'],
      // If needed, add parserOptions, env, rules, etc.:
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module'
      },
      env: {
        browser: true,
        node: true,
        es2020: true
      }
    } as Linter.Config
  });

  // Lint all .jsx and .tsx files
  const results = await eslint.lintFiles([`${workspacePath}/**/*.jsx`, `${workspacePath}/**/*.tsx`]);
  return results;
}

/**
 * Display ESLint results as VS Code diagnostics (inline warnings/errors).
 */
function showA11yDiagnostics(results: any[]) {
  // Clear existing diagnostics
  diagnosticCollection.clear();

  // Store new diagnostics per file
  const diagnosticsMap: { [filePath: string]: vscode.Diagnostic[] } = {};

  for (const result of results) {
    const fileDiagnostics: vscode.Diagnostic[] = [];

    for (const msg of result.messages) {
      // ESLint line/column is 1-based, VS Code is 0-based
      const line = (msg.line ?? 1) - 1;
      const col = (msg.column ?? 1) - 1;
      const range = new vscode.Range(line, col, line, col + 1);

      const severity =
        msg.severity === 2 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;

      const diagnostic = new vscode.Diagnostic(range, msg.message, severity);
      diagnostic.source = 'react-a11y-ai';

      // Attach the ESLint rule ID so we can reference it later if needed
      diagnostic.code = msg.ruleId || 'react-a11y';

      fileDiagnostics.push(diagnostic);
    }

    if (fileDiagnostics.length > 0) {
      diagnosticsMap[result.filePath] = fileDiagnostics;
    }
  }

  // Populate the DiagnosticCollection
  for (const filePath of Object.keys(diagnosticsMap)) {
    const fileUri = vscode.Uri.file(filePath);
    diagnosticCollection.set(fileUri, diagnosticsMap[filePath]);
  }
}

/**
 * Code Action Provider that creates "Fix with AI" Quick Fixes for each diagnostic reported by our extension.
 * 
 * Note the corrected name: CodeActionProvider (not CodeActionsProvider).
 */
class A11yCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Only create fixes for diagnostics from our 'react-a11y-ai' source
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source === 'react-a11y-ai') {
        const title = `Fix with AI: ${diagnostic.message}`;
        const fixAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        fixAction.diagnostics = [diagnostic];
        fixAction.isPreferred = true;

        // Instead of applying an edit directly, we'll invoke a command
        fixAction.command = {
          title: 'Fix with AI',
          command: 'react-a11y-ai.fixWithAI',
          arguments: [document, diagnostic]
        };

        actions.push(fixAction);
      }
    }

    return actions;
  }
}

/**
 * The command that actually calls the AI to get a suggested fix, and applies it to the code.
 */
async function fixWithAI(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
  // If you store the API key in environment variables:
  const openAIApiKey = process.env.OPENAI_API_KEY;
  if (!openAIApiKey) {
    vscode.window.showErrorMessage('OPENAI_API_KEY environment variable not set.');
    return;
  }

  // Extract the code snippet that triggered the diagnostic
  const snippet = document.getText(diagnostic.range);

  // Build a prompt for the AI
  const prompt = `
  The following React code has an accessibility issue:
  ---
  ${snippet}
  ---
  Please provide a fixed version of this snippet (only the code), along with a brief explanation.
  `;

  try {
    const aiResponse = await callOpenAIAPI(openAIApiKey, prompt);
    // In this demo, assume the AI returns code plus explanation
    const { fixedCode, explanation } = parseAIResponseForFix(aiResponse);

    if (!fixedCode) {
      vscode.window.showWarningMessage('No fix was returned by the AI.');
      return;
    }

    // Apply the fix
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, diagnostic.range, fixedCode);
    await vscode.workspace.applyEdit(edit);

    vscode.window.showInformationMessage(`AI fix applied. Explanation: ${explanation || ''}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to get AI fix: ${error.message || error}`);
  }
}

/**
 * Calls the OpenAI API using the GPT-3.5 (or GPT-4) model to get a suggested fix.
 */
async function callOpenAIAPI(apiKey: string, prompt: string): Promise<string> {
  // Cast the response of .json() to `any` to avoid "type unknown" errors.
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are an expert in React accessibility. Provide minimal corrected code snippets.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 500,
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.statusText}`);
  }

  const data: any = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return text;
}

/**
 * Parses the AI response to extract the "fixed code" and a possible explanation.
 * In practice, you'd refine this function based on how you structure the AI prompt/response.
 */
function parseAIResponseForFix(aiResponse: string): { fixedCode: string; explanation: string } {
  // This is a naive example. The AI might give you:
  // ```
  // Here is the fixed code:
  // <SomeCode />
  // Explanation: <some explanation>
  // ```
  //
  // For a robust solution, you might parse for triple-backticks or other delimiters.

  const codeMatch = aiResponse.match(/```(?:[a-z]*\n)?([\s\S]*?)```/);
  const fixedCode = codeMatch ? codeMatch[1].trim() : '';

  const explanationMatch = aiResponse.match(/Explanation:\s*([\s\S]*)/i);
  const explanation = explanationMatch ? explanationMatch[1].trim() : '';

  return { fixedCode, explanation };
}
