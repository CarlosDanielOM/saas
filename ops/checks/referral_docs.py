"""Check the published referral definitions alongside the docs export baseline."""

import os
import runpy
from urllib.request import urlopen

runpy.run_path('/root/saas/ops/checks/docs_llms.py', run_name='__main__')

base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')
for path, phrases in (
    ('/referrals/index.txt', ('referred signups', 'paid conversions', 'Renewals do not add conversions')),
    ('/es/referrals/index.txt', ('registros referidos', 'conversiones de pago', 'Las renovaciones no suman conversiones')),
):
    with urlopen(base + path, timeout=30) as response:
        assert response.status == 200, path
        body = response.read().decode('utf-8')
    for phrase in phrases:
        assert phrase in body, (path, phrase)
print('Referral documentation semantics verified in English and Spanish')
