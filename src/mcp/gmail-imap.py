#!/usr/bin/env python3
"""Servidor MCP mínimo (stdio, JSON-RPC por líneas) para leer Gmail por IMAP con contraseña de aplicación.

Solo lectura. Sin dependencias: librería estándar de Python 3 (macOS la trae).
Credenciales por entorno: GMAIL_USER, GMAIL_APP_PASSWORD (Kogn las guarda cifradas y las pasa al proceso).
Sin proyecto de Google Cloud ni Developer Preview: basta verificación en dos pasos + contraseña de aplicación.
"""
import html as htmlmod
import imaplib
import json
import os
import re
import sys
import email
from email.header import decode_header, make_header

HOST = 'imap.gmail.com'
_imap = None
_all_folder = 'INBOX'


def connect():
    global _imap, _all_folder
    if _imap is not None:
        try:
            _imap.noop()
            return _imap
        except Exception:
            _imap = None
    user = os.environ.get('GMAIL_USER', '').strip()
    pw = os.environ.get('GMAIL_APP_PASSWORD', '').replace(' ', '').strip()
    if not user or not pw:
        raise RuntimeError('Faltan GMAIL_USER y GMAIL_APP_PASSWORD en las claves de la integración')
    m = imaplib.IMAP4_SSL(HOST)
    try:
        m.login(user, pw)
    except imaplib.IMAP4.error as e:
        raise RuntimeError('Gmail rechazó usuario o contraseña de aplicación (¿verificación en dos pasos activa y contraseña de 16 letras?): %s' % e)
    _all_folder = find_all_folder(m)
    _imap = m
    return m


def find_all_folder(m):
    """Carpeta "Todos" de Gmail (su nombre cambia con el idioma): la marcada \\All en LIST."""
    try:
        _typ, rows = m.list()
    except Exception:
        return 'INBOX'
    for row in rows or []:
        s = row.decode('utf-8', 'replace') if isinstance(row, bytes) else str(row)
        if '\\All' in s:
            mt = re.search(r'"([^"]+)"\s*$', s) or re.search(r'\s(\S+)$', s)
            if mt:
                return mt.group(1)
    return 'INBOX'


def hdr(v):
    if not v:
        return ''
    try:
        return str(make_header(decode_header(v)))
    except Exception:
        return str(v)


def decode_part(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return ''
    cs = part.get_content_charset() or 'utf-8'
    try:
        return payload.decode(cs, 'replace')
    except LookupError:
        return payload.decode('utf-8', 'replace')


def html_to_text(h):
    t = re.sub(r'(?is)<(script|style|head).*?</\1>', ' ', h)
    t = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</tr>|</li>|</h\d>', '\n', t)
    t = re.sub(r'(?s)<[^>]+>', ' ', t)
    t = htmlmod.unescape(t)
    t = re.sub(r'[ \t\r\xa0]+', ' ', t)
    return re.sub(r'\n\s*\n+', '\n', t).strip()


def body_text(msg):
    plain, h = None, None
    for part in msg.walk():
        if part.get_content_disposition() == 'attachment':
            continue
        ct = part.get_content_type()
        if ct == 'text/plain' and plain is None:
            plain = decode_part(part)
        elif ct == 'text/html' and h is None:
            h = decode_part(part)
    if plain and plain.strip():
        return plain.strip()
    if h:
        return html_to_text(h)
    return ''


def summary(uid, msg):
    return {
        'id': uid,
        'date': hdr(msg.get('Date')),
        'from': hdr(msg.get('From')),
        'to': hdr(msg.get('To')),
        'subject': hdr(msg.get('Subject')),
    }


def fetch(m, uids, spec):
    """UID FETCH → {uid: bytes crudos}."""
    out = {}
    if not uids:
        return out
    _typ, data = m.uid('FETCH', ','.join(uids), spec)
    for item in data or []:
        if isinstance(item, tuple) and len(item) >= 2:
            mt = re.search(rb'UID (\d+)', item[0])
            if mt:
                out[mt.group(1).decode()] = item[1]
    return out


def search_messages(query, limit=20, folder=None, with_body=False, max_chars=1500):
    m = connect()
    m.select('"%s"' % (folder or _all_folder), readonly=True)
    m.literal = (query or 'newer_than:7d').encode('utf-8')  # literal: admite acentos en la búsqueda
    typ, data = m.uid('SEARCH', 'CHARSET', 'UTF-8', 'X-GM-RAW')
    if typ != 'OK':
        raise RuntimeError('Búsqueda rechazada: %s' % data)
    uids = [u.decode() for u in (data[0] or b'').split()]
    limit = max(1, min(int(limit or 20), 100))
    uids = uids[-limit:][::-1]  # los más recientes primero
    spec = '(BODY.PEEK[])' if with_body else '(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])'
    raw = fetch(m, uids, spec)
    rows = []
    for uid in uids:
        if uid not in raw:
            continue
        msg = email.message_from_bytes(raw[uid])
        row = summary(uid, msg)
        if with_body:
            row['body'] = body_text(msg)[: max(200, min(int(max_chars or 1500), 20000))]
        rows.append(row)
    return json.dumps({'count': len(rows), 'total_matches': len(data[0].split()) if data and data[0] else 0, 'messages': rows}, ensure_ascii=False)


def get_message(message_id, folder=None, max_chars=20000):
    m = connect()
    m.select('"%s"' % (folder or _all_folder), readonly=True)
    raw = fetch(m, [str(message_id)], '(BODY.PEEK[])')
    if str(message_id) not in raw:
        raise RuntimeError('No existe el mensaje %s en esa carpeta' % message_id)
    msg = email.message_from_bytes(raw[str(message_id)])
    row = summary(str(message_id), msg)
    row['body'] = body_text(msg)[: max(500, min(int(max_chars or 20000), 100000))]
    row['attachments'] = [hdr(p.get_filename()) for p in msg.walk() if p.get_content_disposition() == 'attachment']
    return json.dumps(row, ensure_ascii=False)


TOOLS = [
    {
        'name': 'search_messages',
        'description': 'Busca correos en Gmail (solo lectura) con la sintaxis de búsqueda de Gmail: from:, to:, subject:, newer_than:3d, after:2026/01/31, has:attachment, "frase exacta", OR, -excluir. Devuelve id, fecha, de, asunto y, con with_body, el texto del cuerpo (ideal para extraer datos de varios correos en una sola llamada).',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Consulta en sintaxis Gmail, ej: from:info@banco.com newer_than:3d'},
                'limit': {'type': 'integer', 'description': 'Máximo de correos (default 20, máx 100), los más recientes primero'},
                'with_body': {'type': 'boolean', 'description': 'Incluir el texto del cuerpo (recortado a max_chars)'},
                'max_chars': {'type': 'integer', 'description': 'Caracteres de cuerpo por correo (default 1500)'},
                'folder': {'type': 'string', 'description': 'Carpeta IMAP; default: todos los correos'},
            },
            'required': ['query'],
        },
    },
    {
        'name': 'get_message',
        'description': 'Lee un correo completo por su id (de search_messages): cabeceras, texto del cuerpo y nombres de adjuntos.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'message_id': {'type': 'string'},
                'max_chars': {'type': 'integer', 'description': 'Default 20000'},
                'folder': {'type': 'string'},
            },
            'required': ['message_id'],
        },
    },
]


def call(name, a):
    if name == 'search_messages':
        return search_messages(a.get('query', ''), a.get('limit', 20), a.get('folder'), bool(a.get('with_body')), a.get('max_chars', 1500))
    if name == 'get_message':
        return get_message(a.get('message_id', ''), a.get('folder'), a.get('max_chars', 20000))
    raise RuntimeError('Herramienta desconocida: %s' % name)


def result(id_, r):
    return {'jsonrpc': '2.0', 'id': id_, 'result': r}


def handle(req):
    method = req.get('method')
    id_ = req.get('id')
    params = req.get('params') or {}
    if method == 'initialize':
        return result(id_, {'protocolVersion': params.get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'kogn-gmail-imap', 'version': '1.0'}})
    if method == 'ping':
        return result(id_, {})
    if method == 'tools/list':
        return result(id_, {'tools': TOOLS})
    if method == 'tools/call':
        try:
            return result(id_, {'content': [{'type': 'text', 'text': call(params.get('name'), params.get('arguments') or {})}]})
        except Exception as e:  # el modelo recibe el error como texto y decide qué hacer
            return result(id_, {'content': [{'type': 'text', 'text': 'Error: %s' % e}], 'isError': True})
    if id_ is None:
        return None  # notificación (notifications/initialized, cancelled…)
    return {'jsonrpc': '2.0', 'id': id_, 'error': {'code': -32601, 'message': 'Método no soportado: %s' % method}}


def selftest():
    assert hdr('=?UTF-8?B?Tm90aWZpY2FjacOzbiBkZSBjb21wcmE=?=') == 'Notificación de compra'
    assert html_to_text('<html><style>x{}</style><p>Compra <b>$12.50</b> en<br>Super&nbsp;Selectos</p></html>') == 'Compra $12.50 en\nSuper Selectos'
    class FakeImap:
        def list(self):
            return ('OK', [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\All) "/" "[Gmail]/Todos"'])
    assert find_all_folder(FakeImap()) == '[Gmail]/Todos'
    msg = email.message_from_string('From: a@b.c\nSubject: Hola\nContent-Type: text/plain\n\ncuerpo\n')
    assert body_text(msg) == 'cuerpo' and summary('1', msg)['subject'] == 'Hola'
    r = handle({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
    assert [t['name'] for t in r['result']['tools']] == ['search_messages', 'get_message']
    assert handle({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) is None
    err = handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'search_messages', 'arguments': {'query': 'x'}}})
    assert err['result']['isError'] and 'GMAIL_USER' in err['result']['content'][0]['text']
    print('selftest ok')


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        resp = handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
