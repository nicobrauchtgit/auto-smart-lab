"""Import a Moodle export into a hash-addressed catalogue and course resource manifests.

Run through ./dev. Reads PDFs/source/URL activity pages; never executes source or fetches links.
"""
import hashlib
from html.parser import HTMLParser
import io
import json
import logging
from pathlib import Path
import re
import sys
import zipfile

import pypdf

ROOT = Path(__file__).resolve().parent
TASKS = {
    '01-spam': ['spam1', 'spam2', 'spam3'],
    '02-maldoc': ['documents1', 'documents2', 'documents3', 'documents4'],
    'clustering-of-malicious-code': ['code1', 'code2', 'code3'],
    'detection-of-unknown-attacks': ['attacks1'],
    'adversarial-machine-learning-offense': ['offense1', 'offense2'],
    'adversarial-machine-learning-defense': ['defense1'],
}
# These have both dataset-backed task identities and PDF/text resource consumers.
MANIFEST_UNITS = set(list(TASKS)[:4])
PDF_TITLES = {
    'smartlab-spam.pdf': 'Spam Filtering: Basics',
    'mlsec-perf-small.pdf': 'Performance Measures',
    '02-mlsec-ml.pdf': 'Machine Learning in a Nutshell',
    '03-mlsec-feat.pdf': 'Features and Feature Spaces',
    '05-mlsec-ids.pdf': 'Anomaly Detection for Intrusion Detection',
    'smartlab-anomaly.pdf': 'Detection of Unknown Attacks',
    '06b-defense.pdf': 'Adversarial Machine Learning: Defense',
    'fgsm-attack.pdf': 'Explaining and Harnessing Adversarial Examples',
    'Explaining and Harnessing Adversarial Examples.pdf': 'Explaining and Harnessing Adversarial Examples',
    'Towards Deep Learning Models Resistant to Adversarial Attacks.pdf': 'Towards Deep Learning Models Resistant to Adversarial Attacks',
    'maze-attack.pdf': 'MAZE: Data-Free Model Stealing Attack',
    'cwl2-attack.pdf': 'Towards Evaluating the Robustness of Neural Networks',
    'bim-attack.pdf': 'Adversarial Examples in the Physical World',
}


# The Moodle export keeps only Moodle activity URLs, not the external destinations.
# These targets were supplied by the user on 2026-11-16 and are written into the
# link resource text instead of the login-protected Moodle URL. Matching is by the
# same activity-name fragments used for unit assignment below. Links without a
# supplied target (NumPy and Scikit-Learn tutorial) are not imported at all.
LINK_TARGETS = {
    'Novelty_': 'https://scikit-learn.org/stable/modules/outlier_detection.html',
    'Toolpdfid_': 'https://pypi.org/pypi/pdfid/json',  # PyPI's JSON API; the project page serves a bot check
    'XML_ElementTree_': 'https://docs.python.org/3/library/xml.etree.elementtree.html#module-xml.etree.ElementTree',
    'pefile_': 'https://github.com/erocarrera/pefile',
    'Drebin_': 'https://mlsec.org/docs/2014-ndss.pdf',
    'PE_file_': 'https://arxiv.org/pdf/2010.09569',
    'PEiD_': 'https://github.com/packing-box/peid',
    'PDF_Parser_': 'https://py-pdf-parser.readthedocs.io/en/latest/overview.html',
}


class Activity(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.title = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'h2': self.in_title = True
        if tag == 'a' and re.fullmatch(r'https://isis\.tu-berlin\.de/mod/url/view\.php\?id=\d+', attrs.get('href', '')):
            self.links.append(attrs['href'])

    def handle_endtag(self, tag):
        if tag == 'h2': self.in_title = False

    def handle_data(self, data):
        if self.in_title and data.strip(): self.title.append(' '.join(data.split()))


def import_materials(archive):
    logging.getLogger('pypdf').setLevel(logging.ERROR)
    assets = ROOT / '_assets'
    assets.mkdir(exist_ok=True)
    catalogue = {}
    mappings = {unit: [] for unit in TASKS}
    legacy_text = {}
    legacy_files = []
    # Keep the exact already-supplied spam text rather than silently changing extraction.
    for manifest in ROOT.glob('*/manifest.json'):
        entries = json.loads(manifest.read_text())['files']
        for entry in entries:
            file = manifest.parent / entry['file']
            if entry.get('asset') is None and file.is_file():
                assert hashlib.sha256(file.read_bytes()).hexdigest() == entry['sha256']
                legacy_files.append(file)
        for pdf in entries:
            if not pdf['file'].endswith('.pdf'): continue
            text = next((x for x in entries if x['media_type']=='text/plain' and x['title']==pdf['title']), None)
            if text:
                path = ROOT / '_assets' / text['asset'] if text.get('asset') else manifest.parent / text['file']
                if path.is_file(): legacy_text[pdf['sha256']] = path.read_bytes()

    def add(data, extension, title, media_type, pages, origin, units):
        digest = hashlib.sha256(data).hexdigest()
        name = digest + extension
        dest = assets / name
        if dest.exists(): assert dest.read_bytes() == data
        else: dest.write_bytes(data)
        record = catalogue.setdefault(digest, {'id': digest, 'asset': name, 'title': title,
            'media_type': media_type, 'pages': pages, 'bytes': len(data), 'sha256': digest,
            'origins': [], 'units': []})
        if origin not in record['origins']: record['origins'].append(origin)
        for unit in units:
            if unit not in record['units']: record['units'].append(unit)
            if digest not in mappings[unit]: mappings[unit].append(digest)
        return digest

    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None, 'ZIP CRC failure'
        for name in bundle.namelist():
            path = Path(name)
            if path.is_absolute() or '..' in path.parts: raise ValueError('Unsafe archive member')
            if '/Video_' in name: continue
            unit = None
            if '/LinkURL_' in name and name.endswith('/index.html'):
                activity = Activity(); activity.feed(bundle.read(name).decode('utf8'))
                assert len(set(activity.links)) == 1, 'Missing or ambiguous original activity URL'
                title = ' '.join(activity.title)
                if any(word in title.lower() for word in ('video', 'youtube', 'vimeo', 'panopto')): continue
                if 'Novelty_' in name: unit = 'detection-of-unknown-attacks'
                elif any(x in name for x in ('Drebin_', 'PE_file_', 'PEiD_', 'pefile_')): unit = 'clustering-of-malicious-code'
                elif any(x in name for x in ('XML_ElementTree_', 'PDF_Parser_', 'Toolpdfid_')): unit = '02-maldoc'
                elif any(x in name for x in ('NumPy_', 'Scikit-Learn_')): unit = '01-spam'
                assert unit is not None, 'Unmapped URL activity'
                # The export retains Moodle activity URLs, not their external destinations.
                target = next((url for key, url in LINK_TARGETS.items() if key in name), None)
                if target is None: continue  # a login-protected Moodle URL is useless to an agent
                add((title + '\n' + (target or activity.links[0]) + '\n').encode(), '.txt', title, 'text/plain', 1, name, [unit])
                continue
            if '/content/' not in name: continue
            if path.suffix == '.pdf':
                assert path.name in PDF_TITLES, 'Unknown course PDF'
                if any(x in name for x in ('Video_Slides_', 'Paper_FGSM_', 'Paper_Adversarial_Training_')):
                    unit = 'adversarial-machine-learning-defense'
                elif any(x in name for x in ('MAZE_', 'CWL2_', 'BIM_', 'FGSM_basic')):
                    unit = 'adversarial-machine-learning-offense'
                elif any(x in name for x in ('Background_Anomaly_', 'Slides_Detection_')):
                    unit = 'detection-of-unknown-attacks'
                else: unit = '01-spam'
                data = bundle.read(name); digest = hashlib.sha256(data).hexdigest()
                reader = pypdf.PdfReader(io.BytesIO(data)); pages = len(reader.pages); title = PDF_TITLES[path.name]
                add(data, '.pdf', title, 'application/pdf', pages, name, [unit])
                if digest in legacy_text: text = legacy_text[digest]
                elif digest + '.txt' in legacy_text: text = legacy_text[digest + '.txt']
                else:
                    text = ('\n\n'.join(f'--- Page {i} ---\n{page.extract_text() or "[No extractable text]"}'
                        for i, page in enumerate(reader.pages, 1)) + '\n').encode()
                    legacy_text[digest + '.txt'] = text
                add(text, '.txt', title, 'text/plain', pages, name + '#page-text', [unit])
            elif path.name == 'template.py':
                add(bundle.read(name), '.py', 'Offense Python Template', 'text/x-python', 0, name,
                    ['adversarial-machine-learning-offense'])
            elif path.name == 'robustness.zip':
                add(bundle.read(name), '.zip', 'Robustness Code Template', 'application/zip', 0, name,
                    ['adversarial-machine-learning-defense'])
            else: raise ValueError('Unmapped attachment')

    task_map = {}
    for unit, tasks in TASKS.items():
        if unit not in MANIFEST_UNITS: continue
        for task in tasks: task_map[task] = {'unit': unit, 'resource_ids': sorted(mappings[unit])}
        directory = ROOT / unit; directory.mkdir(exist_ok=True)
        entries = []
        for ident in mappings[unit]:
            record = catalogue[ident]
            assert record['media_type'] in ('application/pdf', 'text/plain')
            # Stable, readable snapshot names; identical source content lives in one asset.
            slug = re.sub(r'[^a-z0-9]+', '-', record['title'].lower()).strip('-')
            extension = Path(record['asset']).suffix
            file = slug + extension
            entries.append({'file': file, 'asset': record['asset'], 'title': record['title'],
                'media_type': record['media_type'], 'pages': record['pages'], 'sha256': ident})
        (directory/'manifest.json').write_text(json.dumps({'version': 1, 'files': entries,
            'extraction': {'library': 'pypdf', 'version': pypdf.__version__, 'page_markers': True}}, indent=2)+'\n')
    (ROOT/'catalog.json').write_text(json.dumps({'version': 1, 'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'resources': sorted(catalogue.values(), key=lambda x:x['id'])}, indent=2)+'\n')
    (ROOT/'tasks.json').write_text(json.dumps({'version': 1, 'tasks': task_map}, indent=2)+'\n')
    for file in legacy_files: file.unlink()
    hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in assets.iterdir() if p.is_file()]
    assert len(hashes) == len(set(hashes)), 'Duplicate canonical asset contents'
    print(json.dumps({'canonical_assets':len(catalogue),'task_mappings':len(task_map),
        'active_unit_manifests':len(MANIFEST_UNITS),'duplicate_asset_contents':0,'video_links':0}))


if __name__ == '__main__':
    import_materials(Path(sys.argv[1]))
