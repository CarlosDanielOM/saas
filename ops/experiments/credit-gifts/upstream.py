"""Execute selected unmodified Polar methods with in-memory repository fixtures.

This is not a running Polar server. It isolates the rollover calculations and
benefit event creation at a pinned revision. No SQL, Redis, HTTP, or credentials.
"""
import argparse
import ast
import asyncio
import hashlib
import json
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

COMMIT = '313eba7144d58fc2ac22044e9d2313558b696fd5'
FILES = {
    'server/polar/kit/math.py': '9175d990a76a65cb23b67585d089f0a1264019d302b01d5f11defcbd269d0d6a',
    'server/polar/customer_meter/service.py': '19512e47e7986c7148bc376983e0752e7f42e5f38c653957470d32416489c56c',
    'server/polar/benefit/strategies/meter_credit/service.py': '3aca70e73081dbf9bd14219afa7d809088e57f3a4897591abe4dd53207f43a02',
    'server/polar/subscription/service.py': '57f2eba5b3fb44beab2d2dc4c268285f216685996abf05ba31922d9718f0d6ce',
    'server/polar/models/event.py': '8e9ac7d83b043ac2ab46ca1c1e01691af3cda56dbae18700c72c775c65b8c219',
}


def extract(root, relative, class_name, method_name, namespace):
    tree = ast.parse((root / relative).read_text())
    parent = tree if class_name is None else next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name
    )
    function = next(n for n in parent.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == method_name)
    # Ignore dependency-heavy type annotations and decorators; keep the body exact.
    function.decorator_list = []
    function.returns = None
    for node in ast.walk(function):
        if isinstance(node, ast.arg):
            node.annotation = None
    code = compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), relative, 'exec')
    exec(code, namespace)
    return namespace[method_name]


class FixtureEvents:
    """Fixture event storage, not Polar's SQL event repository."""
    def __init__(self):
        self.events = []

    @classmethod
    def from_session(cls, session):
        return session

    def window(self):
        resets = [i for i, e in enumerate(self.events) if e.name == 'meter.reset']
        return self.events[resets[-1] + 1 if resets else 0:]

    async def get_latest_meter_reset(self, customer, meter_id):
        return next((e for e in reversed(self.events) if e.name == 'meter.reset'), None)

    async def create_event(self, session, event):
        event.ingested_at = datetime(2026, 10, 6, tzinfo=timezone.utc) + timedelta(seconds=len(self.events) + 1)
        self.events.append(event)

    async def get_by_id(self, meter_id):
        return types.SimpleNamespace(id=meter_id)


class FixtureMeter:
    async def _get_latest_current_window_event(self, session, customer, meter, **kwargs):
        return session.window()[-1] if session.window() else None

    async def _get_usage_quantity(self, session, customer, meter, **kwargs):
        return sum(e.user_metadata['credits'] for e in session.window() if e.name == 'ai_usage')

    async def _get_credit_events(self, customer, meter, repository, **kwargs):
        return [e for e in repository.window() if e.name == 'meter.credited' and e.source == 'system']

    async def update_customer_meter(self, *args, **kwargs):
        pass


def system_event(name, *, customer, organization, metadata, **kwargs):
    return types.SimpleNamespace(name=name, source='system', customer_id=customer.id, user_metadata=metadata)


async def run(root):
    manifest = json.loads((root / 'manifest.json').read_text())
    assert manifest['commit'] == COMMIT, 'Wrong upstream revision'
    hashes = {}
    for relative in FILES:
        digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
        assert digest == FILES[relative] == manifest['files'][relative]['sha256'], f'Changed source: {relative}'
        hashes[relative] = digest

    namespace = {
        'uuid': uuid, 'datetime': datetime,
        'EventRepository': FixtureEvents, 'MeterRepository': FixtureEvents,
        'SystemEvent': types.SimpleNamespace(meter_reset='meter.reset', meter_credited='meter.credited'),
        'build_system_event': system_event,
        'utc_now': lambda: namespace['event_service'].events[-1].ingested_at,
        'EventSource': types.SimpleNamespace(system='system', user='user'),
    }
    extract(root, 'server/polar/kit/math.py', None, 'non_negative_running_sum', namespace)
    FixtureMeter.get_rollover_units = extract(root, 'server/polar/customer_meter/service.py', 'CustomerMeterService', 'get_rollover_units', namespace)
    meter_service = FixtureMeter()
    namespace['customer_meter_service'] = meter_service
    strategy = types.SimpleNamespace()
    for method in ['grant', 'cycle', 'revoke', '_create_event']:
        fn = extract(root, 'server/polar/benefit/strategies/meter_credit/service.py', 'BenefitMeterCreditService', method, namespace)
        setattr(strategy, method, types.MethodType(fn, strategy))
    strategy._get_properties = lambda benefit: benefit.properties
    reset_fn = extract(root, 'server/polar/subscription/service.py', 'SubscriptionService', 'reset_meter', namespace)
    subscription_service = types.SimpleNamespace(reset_meter=types.MethodType(reset_fn, types.SimpleNamespace()))
    is_credit = extract(root, 'server/polar/models/event.py', 'Event', 'is_meter_credit', namespace)

    meter_id = '11111111-1111-4111-8111-111111111111'
    customer = types.SimpleNamespace(id='recipient')
    organization = types.SimpleNamespace(id='fixture-org')
    meter = types.SimpleNamespace(id=meter_id)
    subscription = types.SimpleNamespace(customer=customer, organization=organization)
    subscription_meter = types.SimpleNamespace(meter=meter, meter_id=meter_id)
    pack = types.SimpleNamespace(organization=organization, properties={'meter_id': meter_id, 'units': 40000, 'rollover': True})
    plan = types.SimpleNamespace(organization=organization, properties={'meter_id': meter_id, 'units': 200000, 'rollover': False})
    results = []

    async def scenario(name, fixture_credits, usage, expected_rollover):
        events = FixtureEvents()
        namespace['event_service'] = events
        strategy.session = events
        for units, rollover in fixture_credits:
            await events.create_event(events, system_event('meter.credited', customer=customer, organization=organization, metadata={'units': units, 'rollover': rollover}))
        await events.create_event(events, types.SimpleNamespace(name='ai_usage', source='user', user_metadata={'credits': usage}))
        before = sum(e.user_metadata['units'] for e in events.window() if e.name == 'meter.credited') - usage
        carry = await meter_service.get_rollover_units(events, customer, meter)
        assert carry == expected_rollover, (name, carry, expected_rollover)
        await subscription_service.reset_meter(events, subscription, subscription_meter)
        after_reset = sum(e.user_metadata['units'] for e in events.window() if e.name == 'meter.credited')
        assert after_reset == expected_rollover
        results.append({'name': name, 'status': 'passed', 'balanceBeforeReset': before, 'balanceAfterResetBeforeNewAllowance': after_reset})
        print(f'PASS {name}: before={before}, carried={after_reset}')

    await scenario('Negative usage grant with no rollover benefit is lost at reset', [], -40000, 0)
    await scenario('Negative gift adjustment on a paid allowance is lost at reset', [(200000, False)], 50000 - 40000, 0)
    await scenario('Existing rollover credits do not make a negative gift adjustment permanent', [(10000, True)], 5000 - 40000, 10000)
    await scenario('Native rollover pack survives reset', [(40000, True)], 10000, 30000)
    await scenario('Non-rollover allowance is spent before rollover credits', [(200000, False), (40000, True)], 50000, 40000)
    await scenario('Usage beyond the allowance reduces remaining rollover credits', [(200000, False), (40000, True)], 210000, 30000)

    events = FixtureEvents()
    strategy.session = events
    namespace['event_service'] = events
    grant = await strategy.grant(pack, customer, {})
    assert events.events[-1].customer_id == 'recipient'
    assert events.events[-1].user_metadata['rollover'] is True
    await events.create_event(events, types.SimpleNamespace(name='ai_usage', source='user', user_metadata={'credits': 10000}))
    # Subscription creation resets the previous meter window before granting its allowance.
    await subscription_service.reset_meter(events, subscription, subscription_meter)
    plan_grant = await strategy.grant(plan, customer, {})
    for cycle in range(3):
        await subscription_service.reset_meter(events, subscription, subscription_meter)
        plan_grant = await strategy.cycle(plan, customer, plan_grant)
        assert await meter_service.get_rollover_units(events, customer, meter) == 30000
    results.append({'name': 'Native pack keeps 30000 remaining credits across three plan renewals', 'status': 'passed', 'remainingRollover': 30000, 'cycles': 3})
    print('PASS native pack survives three plan renewals')

    await strategy.revoke(pack, customer, grant)
    assert events.events[-1].user_metadata['units'] == -40000
    results.append({'name': 'Native benefit revocation subtracts its last grant amount, not remaining pack usage', 'status': 'passed', 'revokedUnits': -40000})
    print('PASS native revoke emits -40000 units')

    user_named_credit = types.SimpleNamespace(source='user', name='meter.credited')
    assert is_credit(user_named_credit) is False
    assert is_credit(types.SimpleNamespace(source='system', name='meter.credited')) is True
    results.append({'name': 'Naming a user event meter.credited does not turn it into a native credit grant', 'status': 'passed'})
    print('PASS user events cannot impersonate native credit events by name')

    return {
        'mode': 'upstream_methods_with_in_memory_repositories', 'upstreamCommit': COMMIT,
        'sourceHashes': hashes, 'tests': results,
        'limitations': [
            'Repository queries, persistence, timestamps, and provider infrastructure are fixtures.',
            'This executes selected upstream methods, not the hosted Polar sandbox.',
            'The hosted service may run a different revision.',
            'Cancellation, upgrade, downgrade, real checkout, provider deduplication, and refund webhook delivery are not tested.',
        ],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source_directory', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(asyncio.run(run(args.source_directory)), indent=2) + '\n')
