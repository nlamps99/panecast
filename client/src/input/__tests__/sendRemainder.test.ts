import { remainderAfterSend, stripSent } from '../sendRemainder';

it('clears what was sent and keeps typing that followed it', () => {
  expect(remainderAfterSend('ls -la', 'ls -la')).toBe('');
  expect(remainderAfterSend('git status && echo 继续', 'git status')).toBe(' && echo 继续');
});

it('clears nothing once the input was edited before what was sent', () => {
  expect(remainderAfterSend('lx -la', 'ls -la')).toBeNull();
  expect(remainderAfterSend('', 'ls')).toBeNull();
});

describe('stripSent', () => {
  const input = (accept = true) => ({ applyEdit: jest.fn(async () => accept) });

  it('cuts the sent prefix in one edit that checks the text first', async () => {
    const field = input();
    await expect(stripSent(field, 'git status', { text: 'git statusls', composing: false })).resolves.toBe('done');
    expect(field.applyEdit).toHaveBeenCalledWith('git statusls', 'ls', 2, 2);
  });

  it('waits while pinyin is still being composed', async () => {
    const field = input();
    await expect(stripSent(field, 'git status', { text: 'git statusnihao', composing: true })).resolves.toBe('pending');
    expect(field.applyEdit).not.toHaveBeenCalled();
  });

  it('retries when the text changed under the edit', async () => {
    await expect(stripSent(input(false), 'ls', { text: 'ls', composing: false })).resolves.toBe('pending');
  });

  it('leaves an edited input alone', async () => {
    const field = input();
    await expect(stripSent(field, 'ls', { text: 'cat x', composing: false })).resolves.toBe('gone');
    expect(field.applyEdit).not.toHaveBeenCalled();
  });
});
