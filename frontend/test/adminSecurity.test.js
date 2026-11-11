import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordChecks, passwordStrength, describeDevice, describeSecurityEvent, recoveryCodesFile } from '../src/utils/adminSecurity.js';

const failing = (password, options) => passwordChecks(password, options).filter(check => !check.ok).map(check => check.id);

test('the password checklist matches the server rules', () => {
  assert.deepEqual(failing(''), ['length', 'variety', 'common', 'username']);
  assert.deepEqual(failing('short1'), ['length']);
  assert.deepEqual(failing('Password1234'), ['common']);
  assert.deepEqual(failing('123456789012'), ['variety']);
  assert.deepEqual(failing('aaaaaaaaaaaaaa'), ['variety']);
  assert.deepEqual(failing('blueandhack-2026!', { username: 'BlueAndHack' }), ['username']);
  assert.deepEqual(failing('tidy-orbit-canvas-73', { username: 'admin' }), []);
});

test('strength rewards length and variety, and caps passwords that break a rule', () => {
  assert.equal(passwordStrength('').score, 0);
  assert.equal(passwordStrength('Password1234').label, 'Weak');
  assert.ok(passwordStrength('tidy-orbit-canvas-73').score >= 3);
  assert.equal(passwordStrength('correct-Horse-battery-staple-91!').label, 'Strong');
  assert.ok(passwordStrength('abcdefgh12').score <= 2);
});

test('devices and history entries read plainly', () => {
  assert.equal(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), 'Chrome on macOS');
  assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
  assert.equal(describeDevice(null), 'Unknown device');
  assert.deepEqual(describeSecurityEvent({ type: 'sign-in', username: 'yoga', twoFactor: 'app' }), { label: 'Signed in', tone: 'ok', detail: 'yoga · authenticator code' });
  assert.deepEqual(describeSecurityEvent({ type: 'sign-in-failed', unknownAccount: true }), { label: 'Failed sign-in', tone: 'error', detail: 'unknown account' });
  assert.equal(describeSecurityEvent({ type: 'account-unlocked', username: 'yoga', account: 'other' }).detail, 'yoga unlocked other');
  assert.match(recoveryCodesFile(['abcde-fghjk'], 'yoga', new Date('2026-11-11')), /recovery codes for yoga\nCreated 2026-11-11\..*\n\nabcde-fghjk\n$/s);
});
