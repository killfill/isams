/** Servidor que imita la API iSAMS con el fixture real. Para probar el CLI end-to-end. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('test/fixture.raw.json', 'utf8'));
const SID = (i: number) => `SID${i + 1}`;

export function start(port: number) {
  const srv = createServer((req, res) => {
    const url = req.url ?? '';
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) { res.writeHead(401).end('{}'); return; }
    if (!req.headers['user-agent']) { res.writeHead(403).end('{}'); return; }
    res.setHeader('content-type', 'application/json');

    if (url.includes('/students/portal/parents/')) {
      // ~59 campos, como la API real: el extractor debe descartar la PII
      res.end(JSON.stringify({ students: raw.students.map((s: any, i: number) => ({
        id: 1000 + i, schoolId: SID(i), fullName: s.displayName, preferredName: s.displayName.split(' ')[0],
        formGroup: s.formGroup, yearGroup: 12, schoolCode: 'BR', familyId: 634,
        dob: '2011-11-11', homeAddresses: [{ line1: 'Calle Falsa 123' }], schoolEmailAddress: 'x@y.cl',
        religion: 'N/A', ethnicity: null, disabilities: [], medicalFlag: false, latestPhotoPath: '/p.jpg',
      })) }));
      return;
    }
    let m = url.match(/\/markbooks\/students\/(.+)$/);
    if (m) {
      const s = raw.students[Number(m[1].replace('SID', '')) - 1];
      res.end(JSON.stringify(s.markbooks.map((b: any) => ({ id: b.id, name: b.name, description: b.description, publishedColumns: null }))));
      return;
    }
    m = url.match(/\/markbooks\/(\d+)\/students\/(.+)\/columns$/);
    if (m) {
      const s = raw.students[Number(m[2].replace('SID', '')) - 1];
      const b = s.markbooks.find((x: any) => x.id === Number(m![1]));
      res.end(JSON.stringify(b ? b.columns : []));
      return;
    }
    res.writeHead(404).end('{}');
  });
  return new Promise<() => void>((r) => srv.listen(port, () => r(() => srv.close())));
}
