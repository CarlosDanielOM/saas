// Copyright 2011 the V8 project authors. All rights reserved.
// Translated from V8's dateparser.h, dateparser-inl.h, and dateparser.cc at
// https://github.com/nodejs/node/tree/v24.22.1/deps/v8/src/date
// Use is governed by the BSD license reproduced in LICENSE.v8.

//! The token-state machine intentionally follows V8, including its legacy
//! grammar and partially consumed ISO-prefix fallback. Do not replace this
//! with an RFC3339 parser or restart the scanner when ISO parsing falls back.

pub(super) struct Parsed {
    pub(super) year: i32,
    pub(super) month: i32,
    pub(super) day: i32,
    pub(super) hour: i32,
    pub(super) minute: i32,
    pub(super) second: i32,
    pub(super) millisecond: i32,
    pub(super) offset_seconds: Option<i32>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Keyword {
    Invalid,
    Month,
    TimeZone,
    TimeSeparator,
    AmPm,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Token {
    Number {
        value: i32,
        length: usize,
    },
    Symbol(u8),
    Keyword {
        kind: Keyword,
        value: i32,
        length: usize,
    },
    WhiteSpace,
    Unknown,
    End,
    Invalid,
}

impl Token {
    fn fixed_number(self, expected_length: usize) -> Option<i32> {
        match self {
            Self::Number { value, length } if length == expected_length => Some(value),
            _ => None,
        }
    }

    fn number(self) -> Option<i32> {
        match self {
            Self::Number { value, .. } => Some(value),
            _ => None,
        }
    }

    fn sign(self) -> Option<i32> {
        match self {
            Self::Symbol(b'+') => Some(1),
            Self::Symbol(b'-') => Some(-1),
            _ => None,
        }
    }

    fn is_z(self) -> bool {
        matches!(
            self,
            Self::Keyword {
                kind: Keyword::TimeZone,
                value: 0,
                length: 1
            }
        )
    }

    fn is_time_separator(self) -> bool {
        matches!(
            self,
            Self::Keyword {
                kind: Keyword::TimeSeparator,
                ..
            }
        )
    }
}

struct Scanner<I> {
    input: I,
    current: u16,
    next: Token,
}

impl<I: Iterator<Item = u16>> Scanner<I> {
    fn new(mut input: I) -> Self {
        let current = input.next().unwrap_or(0);
        let mut scanner = Self {
            input,
            current,
            next: Token::End,
        };
        scanner.next = scanner.scan();
        scanner
    }

    fn advance(&mut self) {
        self.current = self.input.next().unwrap_or(0);
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn next(&mut self) -> Token {
        let token = self.next;
        self.next = self.scan();
        token
    }

    fn skip_symbol(&mut self, symbol: u8) -> bool {
        if self.next == Token::Symbol(symbol) {
            self.next = self.scan();
            true
        } else {
            false
        }
    }

    fn scan(&mut self) -> Token {
        if self.current == 0 {
            return Token::End;
        }
        if is_digit(self.current) {
            let mut length = 0;
            while self.current == u16::from(b'0') {
                length += 1;
                self.advance();
            }
            let mut value = 0;
            let mut significant_digits = 0;
            while is_digit(self.current) {
                if significant_digits < 9 {
                    value = value * 10 + i32::from(self.current - u16::from(b'0'));
                }
                significant_digits += 1;
                length += 1;
                self.advance();
            }
            return Token::Number { value, length };
        }
        if matches!(self.current, 0x3a | 0x2d | 0x2b | 0x2e | 0x29) {
            let symbol = self.current as u8;
            self.advance();
            return Token::Symbol(symbol);
        }
        // This is deliberately >= 'A', rather than ASCII alphabetic. V8
        // consumes punctuation above 'A', Unicode, and surrogates as words.
        // IsWhiteSpace excludes line terminators, also deliberately.
        if self.current >= u16::from(b'A') && !is_white_space(self.current) {
            let mut prefix = [0; 3];
            let mut length = 0;
            while self.current >= u16::from(b'A') && !is_white_space(self.current) {
                if length < prefix.len() {
                    prefix[length] = self.current | 0x20;
                }
                length += 1;
                self.advance();
            }
            let (kind, value) = lookup_keyword(prefix, length);
            return Token::Keyword {
                kind,
                value,
                length,
            };
        }
        if is_white_space(self.current) || is_line_terminator(self.current) {
            self.advance();
            return Token::WhiteSpace;
        }
        if self.current == u16::from(b'(') {
            let mut balance = 0;
            loop {
                if self.current == u16::from(b')') {
                    balance -= 1;
                } else if self.current == u16::from(b'(') {
                    balance += 1;
                }
                self.advance();
                if balance == 0 || self.current == 0 {
                    break;
                }
            }
            return Token::Unknown;
        }
        self.advance();
        Token::Unknown
    }
}

fn is_digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

// V8 IsWhiteSpace uses Unicode's Zs category plus these four ECMAScript
// additions. The Zs set below is the Unicode 17 set used by pinned Node.
fn is_white_space(unit: u16) -> bool {
    matches!(
        unit,
        0x0009 | 0x000b | 0x000c | 0x0020 | 0x00a0 | 0x1680 | 0x2000
            ..=0x200a | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x000a | 0x000d | 0x2028 | 0x2029)
}

fn lookup_keyword(prefix: [u16; 3], length: usize) -> (Keyword, i32) {
    // ISO T/Z and the two-letter legacy words cannot name a month. Their
    // NUL-padded complete spellings avoid scanning the month table.
    if length <= 2 {
        return match prefix {
            [0x74, 0, 0] => (Keyword::TimeSeparator, 0),
            [0x7a, 0, 0] | [0x75, 0x74, 0] => (Keyword::TimeZone, 0),
            [0x61, 0x6d, 0] => (Keyword::AmPm, 0),
            [0x70, 0x6d, 0] => (Keyword::AmPm, 12),
            _ => (Keyword::Invalid, 0),
        };
    }
    const MONTHS: [[u8; 3]; 12] = [
        *b"jan", *b"feb", *b"mar", *b"apr", *b"may", *b"jun", *b"jul", *b"aug", *b"sep", *b"oct",
        *b"nov", *b"dec",
    ];
    for (index, month) in MONTHS.iter().enumerate() {
        if prefix == month.map(u16::from) {
            return (Keyword::Month, index as i32 + 1);
        }
    }
    if length > 3 {
        return (Keyword::Invalid, 0);
    }
    match prefix {
        [0x75, 0x74, 0x63] | [0x67, 0x6d, 0x74] => (Keyword::TimeZone, 0),
        [0x63, 0x64, 0x74] => (Keyword::TimeZone, -5),
        [0x63, 0x73, 0x74] => (Keyword::TimeZone, -6),
        [0x65, 0x64, 0x74] => (Keyword::TimeZone, -4),
        [0x65, 0x73, 0x74] => (Keyword::TimeZone, -5),
        [0x6d, 0x64, 0x74] => (Keyword::TimeZone, -6),
        [0x6d, 0x73, 0x74] => (Keyword::TimeZone, -7),
        [0x70, 0x64, 0x74] => (Keyword::TimeZone, -7),
        [0x70, 0x73, 0x74] => (Keyword::TimeZone, -8),
        _ => (Keyword::Invalid, 0),
    }
}

#[derive(Default)]
struct DayComposer {
    components: [i32; 3],
    count: usize,
    named_month: Option<i32>,
    iso: bool,
}

impl DayComposer {
    fn add(&mut self, value: i32) -> bool {
        if let Some(slot) = self.components.get_mut(self.count) {
            *slot = value;
            self.count += 1;
            true
        } else {
            false
        }
    }

    fn finish(mut self) -> Option<(i32, i32, i32)> {
        if self.count == 0 {
            return None;
        }
        // V8 increments its index while padding, before selecting YMD or
        // MDY. Preserve that detail for short legacy inputs such as `Jan 1`.
        while self.count < self.components.len() {
            self.add(1);
        }
        let [first, second, third] = self.components;
        let (mut year, month, day) = if let Some(month) = self.named_month {
            if !is_day(first) {
                (first, month, second)
            } else {
                (second, month, first)
            }
        } else if self.iso || !is_day(first) {
            (first, second, third)
        } else {
            (third, first, second)
        };
        if !self.iso {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        (is_month(month) && is_day(day)).then_some((year, month, day))
    }
}

#[derive(Default)]
struct TimeComposer {
    components: [i32; 4],
    count: usize,
    hour_offset: Option<i32>,
}

impl TimeComposer {
    fn add(&mut self, value: i32) -> bool {
        if let Some(slot) = self.components.get_mut(self.count) {
            *slot = value;
            self.count += 1;
            true
        } else {
            false
        }
    }

    fn add_final(&mut self, value: i32) -> bool {
        if !self.add(value) {
            return false;
        }
        while self.count < self.components.len() {
            self.add(0);
        }
        true
    }

    fn is_expecting(&self, value: i32) -> bool {
        match self.count {
            1 | 2 => is_minute(value),
            3 => (0..=999).contains(&value),
            _ => false,
        }
    }

    fn finish(mut self) -> Option<[i32; 4]> {
        // Unfilled slots already hold zero.
        if let Some(offset) = self.hour_offset {
            if !(0..=12).contains(&self.components[0]) {
                return None;
            }
            self.components[0] = self.components[0] % 12 + offset;
        }
        let [hour, minute, second, millisecond] = self.components;
        if (is_hour(hour)
            && is_minute(minute)
            && is_minute(second)
            && (0..=999).contains(&millisecond))
            || (hour == 24 && minute == 0 && second == 0 && millisecond == 0)
        {
            Some(self.components)
        } else {
            None
        }
    }
}

#[derive(Default)]
struct TimeZoneComposer {
    sign: Option<i32>,
    hour: Option<i32>,
    minute: Option<i32>,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_hours: i32) {
        let sign = if offset_hours < 0 { -1 } else { 1 };
        self.sign = Some(sign);
        self.hour = Some(offset_hours * sign);
        self.minute = Some(0);
    }

    fn is_expecting(&self, value: i32) -> bool {
        self.hour.is_some() && self.minute.is_none() && is_minute(value)
    }

    fn is_utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }

    fn finish(self) -> Option<Option<i32>> {
        let Some(sign) = self.sign else {
            return Some(None);
        };
        // V8 deliberately uses 32-bit unsigned arithmetic, including wrap,
        // before checking Smi::kMaxValue. Official 64-bit Node builds use
        // 32-bit Smis (pointer compression disabled), hence i32::MAX.
        let total_seconds = (self.hour.unwrap_or(0) as u32)
            .wrapping_mul(3600)
            .wrapping_add((self.minute.unwrap_or(0) as u32).wrapping_mul(60));
        if total_seconds > i32::MAX as u32 {
            return None;
        }
        Some(Some(total_seconds as i32 * sign))
    }
}

fn is_month(value: i32) -> bool {
    (1..=12).contains(&value)
}

fn is_day(value: i32) -> bool {
    (1..=31).contains(&value)
}

fn is_hour(value: i32) -> bool {
    (0..=23).contains(&value)
}

fn is_minute(value: i32) -> bool {
    (0..=59).contains(&value)
}

fn read_milliseconds(token: Token) -> i32 {
    let Token::Number { mut value, length } = token else {
        unreachable!("milliseconds are read only from numeric tokens");
    };
    match length {
        1 => value *= 100,
        2 => value *= 10,
        4.. => {
            // Numerals skip leading zeroes and cap significant digits at 9;
            // V8 also caps the *original length* here. This differs from
            // simply taking the first three code units of a long fraction.
            for _ in 3..length.min(9) {
                value /= 10;
            }
        }
        _ => {}
    }
    value
}

pub(super) fn parse(units: impl Iterator<Item = u16>) -> Option<Parsed> {
    let mut scanner = Scanner::new(units);
    let mut day = DayComposer::default();
    let mut time = TimeComposer::default();
    let mut timezone = TimeZoneComposer::default();
    let mut token = parse_iso(&mut scanner, &mut day, &mut time, &mut timezone);
    if token == Token::Invalid {
        return None;
    }
    let mut has_read_number = day.count != 0;
    while token != Token::End {
        match token {
            Token::Number { value, .. } => {
                has_read_number = true;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        if time.count != 0 {
                            return None;
                        }
                        time.add(value);
                        time.add(0);
                    } else {
                        if !time.add(value) {
                            return None;
                        }
                        scanner.skip_symbol(b'.');
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(value) {
                    time.add(value);
                    scanner.peek().number()?;
                    let milliseconds = read_milliseconds(scanner.next());
                    // V8 ignores AddFinal's return value here, including
                    // when this follows an already filled fourth slot.
                    time.add_final(milliseconds);
                } else if timezone.is_expecting(value) {
                    timezone.minute = Some(value);
                } else if time.is_expecting(value) {
                    time.add_final(value);
                    let next = scanner.peek();
                    if next != Token::End
                        && next != Token::WhiteSpace
                        && !next.is_z()
                        && next.sign().is_none()
                    {
                        return None;
                    }
                } else {
                    if !day.add(value) {
                        return None;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            Token::Keyword { kind, value, .. } => match kind {
                Keyword::AmPm if time.count != 0 => time.hour_offset = Some(value),
                Keyword::Month => {
                    day.named_month = Some(value);
                    scanner.skip_symbol(b'-');
                }
                Keyword::TimeZone if has_read_number => timezone.set(value),
                _ => {
                    if has_read_number || scanner.peek().number().is_some() {
                        return None;
                    }
                }
            },
            _ if token.sign().is_some() && (timezone.is_utc() || time.count != 0) => {
                timezone.sign = token.sign();
                let (value, length) = match scanner.peek() {
                    Token::Number { value, length } => {
                        scanner.next();
                        (value, length)
                    }
                    _ => (0, 0),
                };
                has_read_number = true;
                if scanner.peek() == Token::Symbol(b':') {
                    timezone.hour = Some(value);
                    timezone.minute = None;
                } else if matches!(length, 1 | 2) {
                    timezone.hour = Some(value);
                    timezone.minute = Some(0);
                } else if matches!(length, 3 | 4) {
                    timezone.hour = Some(value / 100);
                    timezone.minute = Some(value % 100);
                } else {
                    return None;
                }
            }
            _ if has_read_number && (token.sign().is_some() || token == Token::Symbol(b')')) => {
                return None;
            }
            _ => {}
        }
        token = scanner.next();
    }
    let (year, month, day) = day.finish()?;
    let [hour, minute, second, millisecond] = time.finish()?;
    let offset_seconds = timezone.finish()?;
    Some(Parsed {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
        offset_seconds,
    })
}

fn parse_iso<I: Iterator<Item = u16>>(
    scanner: &mut Scanner<I>,
    day: &mut DayComposer,
    time: &mut TimeComposer,
    timezone: &mut TimeZoneComposer,
) -> Token {
    if let Some(sign) = scanner.peek().sign() {
        let sign_token = scanner.next();
        let Some(year) = scanner.peek().fixed_number(6) else {
            return sign_token;
        };
        scanner.next();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if let Some(year) = scanner.peek().fixed_number(4) {
        day.add(year);
        scanner.next();
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        let month = scanner.peek().fixed_number(2);
        if !month.is_some_and(is_month) {
            return scanner.next();
        }
        day.add(month.unwrap());
        scanner.next();
        if scanner.skip_symbol(b'-') {
            let date = scanner.peek().fixed_number(2);
            if !date.is_some_and(is_day) {
                return scanner.next();
            }
            day.add(date.unwrap());
            scanner.next();
        }
    }
    if !scanner.peek().is_time_separator() {
        if scanner.peek() != Token::End {
            return scanner.next();
        }
    } else {
        // A recognized T commits to ISO; all failures after this point are
        // terminal and must not restart in the legacy grammar.
        scanner.next();
        let hour = scanner.peek().fixed_number(2);
        if !hour.is_some_and(|value| (0..=24).contains(&value)) {
            return Token::Invalid;
        }
        let hour = hour.unwrap();
        let hour_is_24 = hour == 24;
        time.add(hour);
        scanner.next();
        if !scanner.skip_symbol(b':') {
            return Token::Invalid;
        }
        let minute = scanner.peek().fixed_number(2);
        if !minute.is_some_and(|value| is_minute(value) && (!hour_is_24 || value == 0)) {
            return Token::Invalid;
        }
        time.add(minute.unwrap());
        scanner.next();
        if scanner.skip_symbol(b':') {
            let second = scanner.peek().fixed_number(2);
            if !second.is_some_and(|value| is_minute(value) && (!hour_is_24 || value == 0)) {
                return Token::Invalid;
            }
            time.add(second.unwrap());
            scanner.next();
            if scanner.skip_symbol(b'.') {
                // Test the complete capped numeral before truncation, so
                // 24:00:00.0001 remains invalid even though it is 0 ms.
                if !scanner
                    .peek()
                    .number()
                    .is_some_and(|value| !hour_is_24 || value == 0)
                {
                    return Token::Invalid;
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_z() {
            scanner.next();
            timezone.set(0);
        } else if let Some(sign) = scanner.peek().sign() {
            timezone.sign = Some(sign);
            scanner.next();
            if let Some(hour_minute) = scanner.peek().fixed_number(4) {
                scanner.next();
                let hour = hour_minute / 100;
                let minute = hour_minute % 100;
                if !is_hour(hour) || !is_minute(minute) {
                    return Token::Invalid;
                }
                timezone.hour = Some(hour);
                timezone.minute = Some(minute);
            } else {
                let hour = scanner.peek().fixed_number(2);
                if !hour.is_some_and(is_hour) {
                    return Token::Invalid;
                }
                timezone.hour = hour;
                scanner.next();
                if !scanner.skip_symbol(b':') {
                    return Token::Invalid;
                }
                let minute = scanner.peek().fixed_number(2);
                if !minute.is_some_and(is_minute) {
                    return Token::Invalid;
                }
                timezone.minute = minute;
                scanner.next();
            }
        }
        if scanner.peek() != Token::End {
            return Token::Invalid;
        }
    }
    if timezone.hour.is_none() && time.count == 0 {
        timezone.set(0);
    }
    day.iso = true;
    Token::End
}
