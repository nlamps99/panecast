#!/usr/bin/env python3
"""Publish immutable release artifacts to Tencent Cloud COS for fast downloads.

Large versioned files (installers, archives, runtimes) are served from COS;
small mutable metadata and pages stay on the web server. Each object is
uploaded public-read under the `panecast/` prefix only, carries its SHA-256
in `x-cos-meta-sha256`, and is never replaced with different content.
Credentials come from TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY and
are never printed.

usage:
  cos.py upload --prefix panecast/cmux FILE...   upload (skips identical objects)
  cos.py verify --prefix panecast/cmux FILE...   check size and SHA-256 metadata
  cos.py delete --key panecast/test/x.txt        remove one object under panecast/
"""
import argparse
import hashlib
import hmac
import http.client
import mimetypes
import os
import sys
import time
import urllib.parse
from pathlib import Path

BUCKET = os.environ.get('PANECAST_COS_BUCKET', 'drink-1304262565')
REGION = os.environ.get('PANECAST_COS_REGION', 'ap-guangzhou')
HOST = f'{BUCKET}.cos.{REGION}.myqcloud.com'
PUBLIC_BASE = f'https://{HOST}'
ROOT_PREFIX = 'panecast/'


def _credentials():
    try:
        return os.environ['TENCENTCLOUD_SECRET_ID'], os.environ['TENCENTCLOUD_SECRET_KEY']
    except KeyError:
        raise SystemExit('Set TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY (see ~/.config/tencentcloud/credentials.env)')


def _authorization(method, path, headers):
    """COS XML API signature v5 (q-sign-algorithm=sha1)."""
    secret_id, secret_key = _credentials()
    now = int(time.time())
    key_time = f'{now - 60};{now + 3600}'
    sign_key = hmac.new(secret_key.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    signed = {k.lower(): v for k, v in headers.items()}
    header_list = ';'.join(sorted(signed))
    header_string = '&'.join(f'{urllib.parse.quote(k, safe="")}={urllib.parse.quote(str(signed[k]), safe="")}' for k in sorted(signed))
    http_string = f'{method.lower()}\n{path}\n\n{header_string}\n'
    string_to_sign = f'sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n'
    signature = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    return (f'q-sign-algorithm=sha1&q-ak={secret_id}&q-sign-time={key_time}&q-key-time={key_time}'
            f'&q-header-list={header_list}&q-url-param-list=&q-signature={signature}')


def _request(method, key, headers=None, body=None, length=None):
    if not key.startswith(ROOT_PREFIX) or '..' in key.split('/'):
        raise SystemExit(f'Refusing a key outside {ROOT_PREFIX}: {key}')
    path = '/' + urllib.parse.quote(key)
    signed = {'host': HOST, **(headers or {})}
    connection = http.client.HTTPSConnection(HOST, timeout=600)
    all_headers = {**signed, 'Authorization': _authorization(method, path, signed)}
    if length is not None:
        all_headers['Content-Length'] = str(length)
    connection.request(method, path, body=body, headers=all_headers)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    return response.status, {k.lower(): v for k, v in response.getheaders()}, data


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def object_key(prefix, path):
    return f'{prefix.strip("/")}/{Path(path).name}'


def public_url(prefix, name=''):
    return f'{PUBLIC_BASE}/{prefix.strip("/")}' + (f'/{name}' if name else '')


def head(key):
    status, headers, _ = _request('HEAD', key)
    return headers if status == 200 else None


def upload(prefix, path):
    """Uploads one file public-read; returns 'uploaded' or 'unchanged'."""
    key, digest, size = object_key(prefix, path), sha256_file(path), os.path.getsize(path)
    existing = head(key)
    if existing is not None:
        if existing.get('x-cos-meta-sha256') == digest and int(existing.get('content-length', -1)) == size:
            return 'unchanged'
        raise SystemExit(f'Refusing to replace a published object with different content: {key}')
    # PowerShell installers run as `irm URL | iex`, which needs text with its charset.
    content_type = 'text/plain; charset=utf-8' if path.endswith('.ps1') else mimetypes.guess_type(path)[0] or 'application/octet-stream'
    headers = {'content-type': content_type, 'x-cos-acl': 'public-read', 'x-cos-meta-sha256': digest}
    with open(path, 'rb') as stream:
        status, _, data = _request('PUT', key, headers, body=stream, length=size)
    if status != 200:
        raise SystemExit(f'Upload failed ({status}) for {key}: {data[:300].decode(errors="replace")}')
    verify(prefix, path)
    return 'uploaded'


def verify(prefix, path):
    key, digest, size = object_key(prefix, path), sha256_file(path), os.path.getsize(path)
    existing = head(key)
    if existing is None or existing.get('x-cos-meta-sha256') != digest or int(existing.get('content-length', -1)) != size:
        raise SystemExit(f'COS object does not match {path}: {key}')
    # Anonymous access proves the object is public, without downloading it.
    connection = http.client.HTTPSConnection(HOST, timeout=60)
    connection.request('HEAD', '/' + urllib.parse.quote(key))
    response = connection.getresponse()
    response.read()
    connection.close()
    if response.status != 200:
        raise SystemExit(f'COS object is not publicly readable ({response.status}): {key}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['upload', 'verify', 'delete'])
    parser.add_argument('--prefix', default='panecast')
    parser.add_argument('--key')
    parser.add_argument('files', nargs='*')
    args = parser.parse_args()
    if not args.prefix.strip('/').startswith(ROOT_PREFIX.strip('/')):
        raise SystemExit(f'Prefix must be under {ROOT_PREFIX}')
    if args.action == 'delete':
        status, _, _ = _request('DELETE', args.key or '')
        print(f'delete {args.key}: {status}')
        return
    for path in args.files:
        if args.action == 'upload':
            print(f'{upload(args.prefix, path):9} {public_url(args.prefix, Path(path).name)}')
        else:
            verify(args.prefix, path)
            print(f'verified  {public_url(args.prefix, Path(path).name)}')


if __name__ == '__main__':
    main()
