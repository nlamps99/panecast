import { SourceNavigation } from '../sourceNavigation';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; };
it('a newer notification route wins even when an earlier source lookup finishes later', async () => {
  const first = deferred();
  const store = { selectSource: jest.fn((id: string) => id === 'a' ? first.promise : Promise.resolve()), openThread: jest.fn(async () => {}) };
  const navigation = new SourceNavigation(store), consumedA = jest.fn(), consumedB = jest.fn();
  const a = navigation.open('a', 'threadA', consumedA);
  const b = navigation.open('b', 'threadB', consumedB);
  await b; first.resolve(); await a;
  expect(store.openThread).toHaveBeenCalledTimes(1); expect(store.openThread).toHaveBeenCalledWith('threadB');
  expect(consumedB).toHaveBeenCalledTimes(1); expect(consumedA).not.toHaveBeenCalled();
});
it('blur, store replacement or explicit selection cancels a pending route finalizer', async () => {
  const thread = deferred(), consumed = jest.fn();
  const store = { selectSource: jest.fn(async () => {}), openThread: jest.fn(() => thread.promise) };
  const navigation = new SourceNavigation(store);
  const task = navigation.open('source', 'thread', consumed);
  await Promise.resolve(); navigation.cancel(); thread.resolve(); await task;
  expect(consumed).not.toHaveBeenCalled(); expect(navigation.active).toBe(false);
});
it('cleanup for an older effect does not cancel a newer navigation intent', async () => {
  const thread = deferred(), complete = jest.fn();
  const store = { selectSource: async () => {}, openThread: () => thread.promise };
  const navigation = new SourceNavigation(store);
  const oldVersion = navigation.version;
  const latest = navigation.open('latest', 'thread', complete);
  navigation.cancel(oldVersion); thread.resolve(); await latest;
  expect(complete).toHaveBeenCalledTimes(1);
});
