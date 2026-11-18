import { describe, it, expect } from 'vitest';
import { WORKSPACE_CURATION, INDEX_HEAD_BYTES, TicketReader, parseTicketFrontmatter, pickRoutine } from '../../core/intents/tickets';
import { createMemFs } from './helpers/memFs';
import { buildBinTree, findBinNode, isContainer, ticketKey } from '../../core/intents/binTree';

const B = '/drive/Lab';
const header = (work = 'routine', routineType = 'workspace-curation') => `---\nticket-type: ${work}\nroutine-type: ${routineType}\n---\n`;

describe('DUE019: curator selection', () => {
    it('requires both fields, normalises quoted values, and finds the routine of the asked class among other tickets, on either shelf', async () => {
        const mem = createMemFs({
            [`${B}/backlog/DUEA01_Bare/INDEX.md`]: header('"Routine" # note', "'WORKSPACE-CURATION'"),
            [`${B}/work/DUE001_Curator/INDEX.md`]: header('project'),
            [`${B}/work/DUEA00_NotCurator/INDEX.md`]: header('routine', 'other'),
            [`${B}/work/DUEX01_Curator/INDEX.md`]: '---\nticket-type: program\n---\n',
            [`${B}/archive/DUEA00_Old/INDEX.md`]: header(),
            [`${B}/child/work/OTH001_Curator/INDEX.md`]: header()
        });
        const reader = new TicketReader(mem.fs);
        expect(parseTicketFrontmatter(header('"Routine" # note', "'WORKSPACE-CURATION'")))
            .toMatchObject({ ticketType: 'routine', routineType: 'workspace-curation' });
        expect((await reader.findRoutine(B, WORKSPACE_CURATION))?.number).toBe('DUEA01');
        const all = await reader.readShelves(B);
        expect(pickRoutine(all.reverse(), WORKSPACE_CURATION)?.number).toBe('DUEA01');
        expect(pickRoutine(all, 'other')?.number).toBe('DUEA00');
        expect(await reader.isRoutineAt(`${B}/work/DUE001_Curator`, WORKSPACE_CURATION)).toBe(false);
    });

    it('two routines of one class are an error naming both, not a silent choice of the lower number', async () => {
        const mem = createMemFs({
            [`${B}/work/DUEA02_Second/INDEX.md`]: header(),
            [`${B}/backlog/DUEA01_First/INDEX.md`]: header()
        });
        await expect(new TicketReader(mem.fs).findRoutine(B, WORKSPACE_CURATION)).rejects
            .toThrow(/несколько рутин класса workspace-curation: DUEA01 .*, DUEA02 /);
    });

    it('missing shelves and missing INDEX are confirmed absence, not an error', async () => {
        const mem = createMemFs({}, [`${B}/work/DUEA01_NoIndex`]);
        expect(await new TicketReader(mem.fs).findRoutine(B, WORKSPACE_CURATION)).toBeNull();
        expect(await new TicketReader(mem.fs).findRoutine('/absent', WORKSPACE_CURATION)).toBeNull();
    });

    it('an unreadable shelf does not mean no curator', async () => {
        const mem = createMemFs();
        mem.fs.readdir = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
        await expect(new TicketReader(mem.fs).findRoutine(B, WORKSPACE_CURATION)).rejects.toThrow('не читается');
    });

    it('an unreadable INDEX or timeout prevents selecting a later curator', async () => {
        const first = `${B}/work/DUEA01_First/INDEX.md`;
        const mem = createMemFs({ [first]: header(), [`${B}/work/DUEA02_Second/INDEX.md`]: header() });
        const read = mem.fs.readHead;
        mem.fs.readHead = async (file, bytes) => {
            if (file === first) { throw new Error('denied'); }
            return read(file, bytes);
        };
        await expect(new TicketReader(mem.fs).findRoutine(B, WORKSPACE_CURATION)).rejects.toThrow(first);
        mem.fs.readHead = async () => new Promise<string>(() => undefined);
        await expect(new TicketReader(mem.fs, 5).findRoutine(B, WORKSPACE_CURATION)).rejects.toThrow('timeout');
    });

    it('a truncated/unfinished header stays unknown even after a soft bin read cached it', async () => {
        const mem = createMemFs({ [`${B}/work/DUEA01_First/INDEX.md`]: `---\n${'x'.repeat(INDEX_HEAD_BYTES)}\n---\n` });
        const reader = new TicketReader(mem.fs);
        await reader.readShelves(B);
        await expect(reader.findRoutine(B, WORKSPACE_CURATION)).rejects.toThrow('шапка');
    });

    it('shares header cache with the bin, and notices changed routine-type', async () => {
        const file = `${B}/work/DUEA01_First/INDEX.md`;
        const mem = createMemFs({ [file]: header() });
        const reader = new TicketReader(mem.fs);
        await reader.readShelves(B);
        const reads = mem.calls.readHead;
        expect((await reader.findRoutine(B, WORKSPACE_CURATION))?.number).toBe('DUEA01');
        expect(mem.calls.readHead).toBe(reads);
        await mem.fs.writeFile(file, header('routine', 'other'), 'utf8');
        expect(await reader.findRoutine(B, WORKSPACE_CURATION)).toBeNull();
        expect(await reader.isRoutineAt(`${B}/work/DUEA01_First`, WORKSPACE_CURATION)).toBe(false);
    });
});

describe('DUE039: a lettered number types the ticket, as on the Backend', () => {
    const old = '---\nticket-type: process\nprocess-type: curator\n---\n';

    it('a routine reopened with old frontmatter is still a container, and its project stands under it', async () => {
        const mem = createMemFs({
            [`${B}/work/DUEA02_Migration/INDEX.md`]: old,
            [`${B}/work/DUE037_Child/INDEX.md`]: '---\nticket-type: project\nparent: DUEA02\n---\n',
            [`${B}/work/DUEX07_NoIndex/notes.md`]: ''
        });
        const tickets = await new TicketReader(mem.fs).readShelves(B);
        const routine = tickets.find(ticket => ticket.number === 'DUEA02')!;
        expect(routine.ticketType).toBe('routine');
        expect(isContainer(routine)).toBe(true);
        expect(isContainer(tickets.find(ticket => ticket.number === 'DUEX07')!)).toBe(true);
        const node = findBinNode(buildBinTree(tickets, []), ticketKey(routine))!;
        expect(node.children.map(child => child.kind === 'ticket' && child.ticket.number)).toEqual(['DUE037']);
    });

    it('the class still comes from `routine-type`: old frontmatter names no curator', async () => {
        const mem = createMemFs({
            [`${B}/work/DUEA02_Migration/INDEX.md`]: old,
            [`${B}/work/DUEA03_Curation/INDEX.md`]: '---\nticket-type: process\nroutine-type: workspace-curation\n---\n'
        });
        const reader = new TicketReader(mem.fs);
        expect((await reader.findRoutine(B, WORKSPACE_CURATION))?.number).toBe('DUEA03');
        expect(await reader.isRoutineAt(`${B}/work/DUEA03_Curation`, WORKSPACE_CURATION)).toBe(true);
        expect(await reader.isRoutineAt(`${B}/work/DUEA02_Migration`, WORKSPACE_CURATION)).toBe(false);
    });
});
