import { describe, expect, it } from 'vitest';
import { listPrintableFiles } from './file-list.js';

/** Answers Cmd 258 the way the real Mars 5 Ultra did, per path. */
function printer(tree: Record<string, { name: string; type: number }[] | 'fail'>) {
  const asked: string[] = [];
  return {
    asked,
    listFiles: async (url = '/local') => {
      asked.push(url);
      const list = tree[url];
      if (list === undefined || list === 'fail') return { Data: { Ack: -1 } };
      return { Data: { Ack: 0, FileList: list } };
    },
  };
}

describe('listPrintableFiles', () => {
  it('finds files in /local and in folders on the USB stick', async () => {
    const p = printer({
      '/local': [{ name: '/local/keystamp.goo', type: 1 }],
      '/usb': [
        { name: '/usb/System Volume Information', type: 0 },
        { name: '/usb/Printing Test', type: 0 },
      ],
      '/usb/Printing Test': [
        { name: '/usb/Printing Test/ROOK.goo', type: 1 },
        { name: '/usb/Printing Test/readme.pdf', type: 1 },
      ],
    });

    expect(await listPrintableFiles(p)).toEqual([
      { path: '/local/keystamp.goo', name: 'keystamp.goo', storage: 'local', folder: '' },
      {
        path: '/usb/Printing Test/ROOK.goo',
        name: 'ROOK.goo',
        storage: 'usb',
        folder: 'Printing Test',
      },
    ]);
    expect(p.asked).not.toContain('/usb/System Volume Information');
  });

  it('copes with no USB stick', async () => {
    const p = printer({ '/local': [{ name: '/local/a.ctb', type: 1 }], '/usb': 'fail' });
    expect((await listPrintableFiles(p)).map((f) => f.path)).toEqual(['/local/a.ctb']);
  });

  it('collapses the doubled slash the printer returns for "/usb/"', async () => {
    const p = printer({ '/local': [], '/usb': [{ name: '/usb//x.goo', type: 1 }] });
    expect((await listPrintableFiles(p))[0]?.path).toBe('/usb/x.goo');
  });

  it('ignores entries that do not belong to the folder it asked for', async () => {
    const same = [{ name: '/local/a.goo', type: 1 }];
    const p = printer({ '/local': same, '/usb': same });
    expect((await listPrintableFiles(p)).map((f) => `${f.storage}:${f.path}`)).toEqual([
      'local:/local/a.goo',
    ]);
  });
});
