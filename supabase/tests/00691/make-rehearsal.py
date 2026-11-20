"""Build prod-rehearsal.sql: the rehearsal template with migration 00691 pasted in, and its md5.

    python -I supabase/tests/00691/make-rehearsal.py

The rehearsal checks the md5 first, so a copy that changed on the way (a tool that rewrites
backslashes, a paste that adds carriage returns) stops it before anything runs.
"""
import hashlib
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MIGRATION = ROOT / 'supabase' / 'migrations' / '00691_driver_approval_bonus.sql'

mig = MIGRATION.read_text(encoding='utf-8')
template = (HERE / 'prod-rehearsal.template.sql').read_text(encoding='utf-8')
for name, text in (('migration', mig), ('template', template)):
    assert chr(13) not in text, f'the {name} has carriage returns'
    assert chr(92) not in text, f'the {name} has a backslash'
assert '$mig$' not in mig, 'the migration uses the $mig$ quote'

out = (template
       .replace('__MIGRATION_MD5__', hashlib.md5(mig.encode('utf-8')).hexdigest())
       .replace('__MIGRATION__', mig))
(HERE / 'prod-rehearsal.sql').write_text(out, encoding='utf-8', newline='')
print('prod-rehearsal.sql:', len(out), 'characters; migration md5', hashlib.md5(mig.encode('utf-8')).hexdigest())
