#!/usr/bin/env python3
"""Collect a bounded public Wiki search and article with provenance, without API keys."""
import argparse
import datetime as dt
import hashlib
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', choices=['wikipedia', 'wikivoyage'], default='wikipedia')
    parser.add_argument('--language', default='en')
    parser.add_argument('--query', default='Uffizi')
    parser.add_argument('--title', default='Uffizi', help='Exact expected title from search; never silently take first match')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--network', choices=['system', 'direct'], default='system')
    parser.add_argument('--api', choices=['action', 'core'], default='action',
                        help='Core is an explicitly selected Wikimedia gateway; scheduled for gradual deprecation')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z]{2,3}(?:-[a-z]+)?', args.language):
        parser.error('Expected a Wiki language code')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = args.output or Path('data/content-samples') / f'{args.project}-{stamp}.json'
    if output.exists():
        parser.error('Output already exists; choose a new path')
    endpoint = (f'https://{args.language}.{args.project}.org/w/api.php' if args.api == 'action'
                else f'https://api.wikimedia.org/core/v1/{args.project}/{args.language}/')
    proxies = urllib.request.getproxies() if args.network == 'system' else {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
    report = {'schemaVersion': 1, 'source': args.project, 'language': args.language,
              'query': args.query, 'expectedTitle': args.title, 'startedAt': now(),
              'channel': 'public_mediawiki_api' if args.api == 'action' else 'public_wikimedia_core_api',
              'api': args.api, 'network': args.network,
              'proxyConfigured': bool(proxies), 'credentialUsed': False,
              'requests': [], 'records': [], 'status': 'started'}

    def request(params, path=''):
        if args.api == 'action':
            params = {'format': 'json', 'formatversion': 2, 'maxlag': 5, **params}
        url = endpoint + path + ('?' + urllib.parse.urlencode(params) if params else '')
        rec = {'url': url, 'startedAt': now()}
        report['requests'].append(rec)
        started = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'TravelAssistant/0.1 (personal travel research; bounded public sample)',
                'Accept': 'application/json',
            })
            with opener.open(req, timeout=25) as response:
                rec['httpStatus'] = response.status
                body = response.read(2_000_001)
            if len(body) > 2_000_000:
                raise ValueError('Response exceeds bounded sample size')
            rec['bytes'] = len(body)
            rec['sha256'] = hashlib.sha256(body).hexdigest()
            data = json.loads(body)
            if data.get('error'):
                raise ValueError('API error: ' + str(data['error'].get('code', 'unknown')))
            return data
        except urllib.error.HTTPError as error:
            rec['httpStatus'] = error.code
            raise
        finally:
            rec['elapsedMs'] = round((time.monotonic() - started) * 1000)

    try:
        if args.api == 'action':
            search = request({'action': 'query', 'list': 'search', 'srsearch': args.query, 'srlimit': 3, 'srnamespace': 0})
            candidates = search.get('query', {}).get('search', [])
        else:
            search = request({'q': args.query, 'limit': 3}, 'search/page')
            candidates = [{'pageid': p['id'], 'title': p['title'], 'snippet': p.get('excerpt', '')}
                          for p in search.get('pages', [])]
        report['searchResults'] = [{'pageId': p['pageid'], 'title': p['title'],
                                    'snippet': html.unescape(re.sub('<[^>]+>', '', p.get('snippet', '')))} for p in candidates]
        match = next((p for p in candidates if p['title'].casefold() == args.title.casefold()), None)
        if match is None:
            report['status'] = 'needs_entity_selection' if candidates else 'no_search_results'
        else:
            if args.project == 'wikivoyage':
                # Wikivoyage asks small consumers to space page requests by 30 seconds.
                time.sleep(30)
            if args.api == 'action':
                data = request({'action': 'query', 'pageids': match['pageid'],
                                'prop': 'extracts|info|revisions', 'explaintext': 1,
                                'inprop': 'url', 'rvprop': 'ids|timestamp',
                                'meta': 'siteinfo', 'siprop': 'rightsinfo'})
                page = next((p for p in data.get('query', {}).get('pages', []) if p.get('pageid') == match['pageid']), None)
                rights = data.get('query', {}).get('rightsinfo', {})
                content_type = 'article_plaintext'
            else:
                data = request({}, 'page/' + urllib.parse.quote(match['title'].replace(' ', '_'), safe=''))
                if data.get('content_model') != 'wikitext':
                    raise ValueError('Expected a wikitext article')
                latest = data.get('latest', {})
                page = {'pageid': data.get('id'), 'title': data.get('title'), 'extract': data.get('source', ''),
                        'fullurl': f'https://{args.language}.{args.project}.org/wiki/' + urllib.parse.quote(data.get('key', ''), safe=''),
                        'revisions': [{'revid': latest.get('id'), 'timestamp': latest.get('timestamp')}]}
                rights = data.get('license', {})
                content_type = 'article_wikitext'
            if (not page or page.get('missing') or page.get('title') != match['title']
                    or page.get('pageid') != match['pageid']):
                raise ValueError('Article identity does not match search result')
            content = page.get('extract', '').strip()
            if len(content) < 500:
                raise ValueError('Article body is missing or too short for this sample')
            revision = (page.get('revisions') or [{}])[0]
            if not revision.get('revid'):
                raise ValueError('Article revision metadata missing')
            source_url = page['fullurl']
            if not rights.get('url'):
                raise ValueError('Content license metadata missing')
            report['records'] = [{
                'sourceUrl': source_url, 'title': page['title'], 'pageId': page['pageid'],
                'revisionId': revision['revid'], 'revisionTimestamp': revision.get('timestamp'),
                'revisionUrl': f'https://{args.language}.{args.project}.org/w/index.php?oldid={revision["revid"]}',
                'historyUrl': f'https://{args.language}.{args.project}.org/w/index.php?title={urllib.parse.quote(page["title"])}&action=history',
                'retrievedAt': now(), 'rights': rights,
                'contentType': content_type, 'text': content,
                'textCharacters': len(content), 'textSha256': hashlib.sha256(content.encode()).hexdigest(),
                'limitations': ['Search returns at most three candidates', 'One selected article',
                                ('Plaintext extract omits some formatting, media and references' if args.api == 'action'
                                 else 'Raw wikitext retains templates and markup; no rendered media or template expansion'),
                                *(['Core gateway is scheduled for gradual deprecation; recheck official migration notice before production use']
                                  if args.api == 'core' else []),
                                'Revision time is not the date of every travel fact',
                                'Current opening times, fares and availability are not verified'],
            }]
            report['status'] = 'search_and_article_read_passed'
    except Exception as error:
        if isinstance(error, urllib.error.HTTPError):
            report['status'] = 'http_error'
            report['error'] = {'type': type(error).__name__, 'httpStatus': error.code}
        else:
            report['status'] = 'transport_or_content_error'
            # Exception text contains no credentials: this collector has none.
            report['error'] = {'type': type(error).__name__, 'message': str(error)[:300]}
    report['finishedAt'] = now()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    output.chmod(0o600)
    print(json.dumps({'output': str(output.resolve()), 'status': report['status'],
                      'requests': len(report['requests']), 'records': len(report['records']),
                      'textCharacters': sum(r.get('textCharacters', 0) for r in report['records'])}, ensure_ascii=False))
    return 0 if report['status'] == 'search_and_article_read_passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
