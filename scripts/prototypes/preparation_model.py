"""Deterministic illustrative schedule, not a benchmark or runtime prediction."""
import json


def schedule(count, preparation, upload, provider_interval=0, *, ahead=False, overhead=0):
    # Identical already-downloaded input availability for both candidates. No
    # provider request is moved earlier or overlapped by this model.
    rows = []
    for i in range(count):
        available = i * provider_interval
        # One next slot becomes free only when prior artifact becomes active.
        slot_free = rows[-1]['upload_start' if ahead else 'upload_end'] if rows else 0
        start = max(available, slot_free)
        prepared = start + preparation + (overhead if ahead else 0)
        network_start = max(prepared, rows[-1]['upload_end'] if rows else 0)
        rows.append({'track': i, 'provider_ready': available, 'prepare_start': start,
                     'prepare_end': prepared, 'upload_start': network_start, 'upload_end': network_start + upload})
    return rows


def scenarios():
    result = []
    for name, prep, upload, interval, overhead in [
        ('small_preparation', .2, 20, 0, 0),
        ('large_preparation', 10, 20, 0, 0),
        ('provider_pacing_dominates', 10, 20, 40, 0),
        ('overhead_can_erase_gain', .2, 20, 0, 3),
    ]:
        baseline = schedule(10, prep, upload, interval)
        ahead = schedule(10, prep, upload, interval, ahead=True, overhead=overhead)
        result.append({'scenario': name, 'tracks': 10, 'preparation_seconds': prep,
                       'upload_seconds': upload, 'provider_interval_seconds': interval,
                       'additional_preparation_overhead_seconds': overhead,
                       'baseline_seconds': baseline[-1]['upload_end'], 'ahead_seconds': ahead[-1]['upload_end'],
                       'synthetic_saved_seconds': round(baseline[-1]['upload_end'] - ahead[-1]['upload_end'], 6),
                       'provider_ready_times_identical': True, 'max_network_chains': 1,
                       'measured_live_throughput': None})
    return result


if __name__ == '__main__':
    print(json.dumps({'kind': 'synthetic_schedule_only', 'scenarios': scenarios()}, indent=2))
