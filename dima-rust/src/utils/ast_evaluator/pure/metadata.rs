use super::super::FunctionMetadata;
use super::PureFunction;

pub(crate) fn definitions() -> Vec<(&'static str, PureFunction, FunctionMetadata)> {
    let mut entries = vec![
        ("upper", PureFunction::Upper, FunctionMetadata {
            description: "Converts text to UPPERCASE.".into(),
            syntax: "upper text".into(),
            category: "string".into(),
            examples: vec!["upper hello".into()],
            keywords: Some(vec!["uppercase".into(), "mayusculas".into(), "caps".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("lower", PureFunction::Lower, FunctionMetadata {
            description: "Converts text to lowercase.".into(),
            syntax: "lower text".into(),
            category: "string".into(),
            examples: vec!["lower HELLO".into()],
            keywords: Some(vec!["lowercase".into(), "minusculas".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("title", PureFunction::Title, FunctionMetadata {
            description: "Converts text to Title Case (first letter of each word capitalized).".into(),
            syntax: "title text".into(),
            category: "string".into(),
            examples: vec!["title hello world".into()],
            keywords: Some(vec!["title case".into(), "capitalizar palabras".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("capitalize", PureFunction::Capitalize, FunctionMetadata {
            description: "Capitalizes only the first character of the text.".into(),
            syntax: "capitalize text".into(),
            category: "string".into(),
            examples: vec!["capitalize hello world".into()],
            keywords: Some(vec!["capitalize".into(), "primera letra mayuscula".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("trim", PureFunction::Trim, FunctionMetadata {
            description: "Removes leading and trailing whitespace from text.".into(),
            syntax: "trim text".into(),
            category: "string".into(),
            examples: vec!["trim $(touser)".into()],
            keywords: Some(vec!["trim".into(), "whitespace".into(), "espacios".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("length", PureFunction::Length, FunctionMetadata {
            description: "Returns the character count of the text.".into(),
            syntax: "length text".into(),
            category: "string".into(),
            examples: vec!["length hello".into()],
            keywords: Some(vec!["length".into(), "count characters".into(), "longitud".into(), "cuantas letras".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("slice", PureFunction::Slice, FunctionMetadata {
            description: "Extracts a substring by index. Negative indexes wrap from the end. Numeric args come first, then the text.".into(),
            syntax: "slice start [end] text".into(),
            category: "string".into(),
            examples: vec!["slice 0 5 hello world".into(), "slice -5 hello world".into()],
            keywords: Some(vec!["substring".into(), "slice".into(), "cut".into(), "recortar".into(), "parte del texto".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("replace", PureFunction::Replace, FunctionMetadata {
            description: "Literal replace-all of a search string with a replacement (no regex). Quote multi-word search/replacement.".into(),
            syntax: "replace search replacement text".into(),
            category: "string".into(),
            examples: vec!["replace a o banana".into()],
            keywords: Some(vec!["replace".into(), "sustituir".into(), "reemplazar".into(), "cambiar texto".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("user", PureFunction::User, FunctionMetadata {
            description: "Returns the username of the caller / current chatter. Optional \"ignore\" filters strip characters from that name: \"symbols\" removes every character that is not a letter, combining mark or number, \"numbers\" removes numeric characters. Both filters can be combined in any order, and the name keeps its casing. Returns \"viewer\" when the filters leave no letters or numbers.".into(),
            syntax: "user [ignore [symbols] [numbers]]".into(),
            category: "user".into(),
            examples: vec!["user".into(), "user ignore symbols".into(), "user ignore numbers".into(), "user ignore symbols numbers".into()],
            keywords: Some(vec!["caller".into(), "username".into(), "who".into(), "usuario".into(), "nombre".into(), "quien".into(), "ignore".into(), "filter".into(), "symbols".into(), "numbers".into(), "filtrar".into(), "simbolos".into(), "numeros".into()]),
            ..Default::default()
        }),
        ("touser", PureFunction::ToUser, FunctionMetadata {
            description: "Returns the target username from the first argument; falls back to the caller when no argument is given.".into(),
            syntax: "touser [target]".into(),
            category: "user".into(),
            examples: vec!["touser".into(), "touser $(randomuser)".into()],
            keywords: Some(vec!["target".into(), "argument".into(), "objetivo".into(), "destinatario".into()]),
            ..Default::default()
        }),
        ("random", PureFunction::Random, FunctionMetadata {
            description: "Returns a random integer from 0 up to max-1. Max defaults to 100.".into(),
            syntax: "random [max]".into(),
            category: "random".into(),
            examples: vec!["random".into(), "random 50".into()],
            keywords: Some(vec!["dice".into(), "random number".into(), "numero aleatorio".into(), "dado".into(), "azar".into()]),
            ..Default::default()
        }),
        ("twitch.modiversary", PureFunction::Modiversary, FunctionMetadata {
            description: "Number of months the viewer has been a moderator, from modiversary.months. Returns 0 when no valid moderator anniversary is present.".into(),
            syntax: "twitch.modiversary".into(),
            category: "event-data".into(),
            examples: vec!["twitch.modiversary".into()],
            keywords: Some(vec!["modiversary".into(), "moderator anniversary".into(), "moderator months".into(), "aniversario de moderación".into(), "meses de moderador".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("twitch.streak", PureFunction::WatchStreak, FunctionMetadata {
            description: "Watch streak count from the current chat notification (watch_streak.streak_count). Returns 0 when no valid watch streak is present.".into(),
            syntax: "twitch.streak".into(),
            category: "event-data".into(),
            examples: vec!["twitch.streak".into()],
            keywords: Some(vec!["watch streak".into(), "stream streak".into(), "consecutive broadcasts".into(), "racha".into(), "racha de streams".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("raid.channel", PureFunction::RaidChannel, FunctionMetadata {
            description: "Display name of the channel raiding us (raid event data).".into(),
            syntax: "raid.channel".into(),
            category: "event-data".into(),
            examples: vec!["raid.channel".into()],
            keywords: Some(vec!["raid".into(), "who raids".into(), "quien raidea".into(), "canal del raid".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("raid.login", PureFunction::RaidLogin, FunctionMetadata {
            description: "Login name of the channel raiding us (raid event data).".into(),
            syntax: "raid.login".into(),
            category: "event-data".into(),
            examples: vec!["raid.login".into()],
            keywords: Some(vec!["raid login".into(), "login del raid".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("raid.viewers", PureFunction::RaidViewers, FunctionMetadata {
            description: "Number of viewers brought by the incoming raid (raid event data).".into(),
            syntax: "raid.viewers".into(),
            category: "event-data".into(),
            examples: vec!["raid.viewers".into()],
            keywords: Some(vec!["raid viewers".into(), "viewers del raid".into(), "cuantos en el raid".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("cheer.amount", PureFunction::CheerAmount, FunctionMetadata {
            description: "Bits amount of the current cheer event.".into(),
            syntax: "cheer.amount".into(),
            category: "event-data".into(),
            examples: vec!["cheer.amount".into()],
            keywords: Some(vec!["bits".into(), "cheer".into(), "cuantos bits".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("cheer.message", PureFunction::CheerMessage, FunctionMetadata {
            description: "Text message attached to the current cheer event.".into(),
            syntax: "cheer.message".into(),
            category: "event-data".into(),
            examples: vec!["cheer.message".into()],
            keywords: Some(vec!["cheer message".into(), "mensaje del cheer".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("sub.tier", PureFunction::SubTier, FunctionMetadata {
            description: "Subscription tier of the current sub event (Prime, Tier 1, Tier 2, Tier 3).".into(),
            syntax: "sub.tier".into(),
            category: "event-data".into(),
            examples: vec!["sub.tier".into()],
            keywords: Some(vec!["sub tier".into(), "tier de sub".into(), "nivel de suscripcion".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("sub.months", PureFunction::SubMonths, FunctionMetadata {
            description: "Cumulative subscription months of the current sub event.".into(),
            syntax: "sub.months".into(),
            category: "event-data".into(),
            examples: vec!["sub.months".into()],
            keywords: Some(vec!["sub months".into(), "meses de sub".into(), "antiguedad sub".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("gifted.user", PureFunction::GiftedUser, FunctionMetadata {
            description: "Recipient username of a gifted subscription event.".into(),
            syntax: "gifted.user".into(),
            category: "event-data".into(),
            examples: vec!["gifted.user".into()],
            keywords: Some(vec!["gifted sub".into(), "sub regalada".into(), "quien recibio el gift".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("hypetrain.progress", PureFunction::HypeTrainProgress, FunctionMetadata {
            description: "Current hype train progress points.".into(),
            syntax: "hypetrain.progress".into(),
            category: "event-data".into(),
            examples: vec!["hypetrain.progress".into()],
            keywords: Some(vec!["hype train".into(), "tren del hype".into(), "progreso".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("hypetrain.level", PureFunction::HypeTrainLevel, FunctionMetadata {
            description: "Current hype train level.".into(),
            syntax: "hypetrain.level".into(),
            category: "event-data".into(),
            examples: vec!["hypetrain.level".into()],
            keywords: Some(vec!["hype train level".into(), "nivel del hype train".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("hypetrain.end", PureFunction::HypeTrainEnd, FunctionMetadata {
            description: "End time of the current hype train.".into(),
            syntax: "hypetrain.end".into(),
            category: "event-data".into(),
            examples: vec!["hypetrain.end".into()],
            keywords: Some(vec!["hype train end".into(), "fin del hype train".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("shoutout.channel", PureFunction::ShoutoutChannel, FunctionMetadata {
            description: "Target channel of a shoutout event.".into(),
            syntax: "shoutout.channel".into(),
            category: "event-data".into(),
            examples: vec!["shoutout.channel".into()],
            keywords: Some(vec!["shoutout".into(), "canal del shoutout".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
        ("reward.input", PureFunction::RewardInput, FunctionMetadata {
            description: "User input text from a channel point reward redemption.".into(),
            syntax: "reward.input".into(),
            category: "event-data".into(),
            examples: vec!["reward.input".into()],
            keywords: Some(vec!["reward input".into(), "user input".into(), "texto del canje".into(), "input de la recompensa".into()]),
            surfaces: Some(vec!["authoring".into()]),
            ..Default::default()
        }),
    ];
    let mut alias = entries.last().expect("reward metadata").2.clone();
    alias.alias_of = Some("reward.input".into());
    entries.push(("redemption.input", PureFunction::RewardInput, alias));
    entries
}
