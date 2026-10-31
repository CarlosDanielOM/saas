#[path = "delete_message.chat.rs"]
pub mod delete_message;
// Context-free plain chat send shared by announcement helpers; the AST/context
// half of send_message.chat.ts remains separate work.
pub mod send_message_plain;
