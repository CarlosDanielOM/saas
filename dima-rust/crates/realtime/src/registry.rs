//! How a realtime module declares its Socket.IO namespaces and receives the handles it emits
//! through (P4-SKEL; plan section 2.1, cycle C02).
//!
//! The API binary (P4-BIN-API) makes one [`Registry`] around the `dima_socketio` [`Builder`],
//! registers every realtime module in the reference's order (pets, overlays, desktop: plan
//! section 5.2), then [`Registry::build`]s the server it serves in front of the app. Each module
//! implements [`RealtimeModule`]: while it registers it sees only [`Sockets`], the builder
//! tagged with its name, declares its namespaces and families there, and returns its handle (the
//! typed [`NamespaceRef`]s and the state it built around them). [`Registry::declared`] tells
//! which module owns which namespace, and a name declared twice is refused with both owners.
//!
//! ```
//! use dima_realtime::registry::{RealtimeModule, RegisterError, Registry, Sockets};
//! use dima_socketio::{ConnectError, Handshake, Namespace, NamespaceOptions, NamespaceRef};
//!
//! struct Clips;
//! impl Namespace for Clips {
//!     type Data = ();
//!     async fn check(&self, _: &Handshake, _: &str) -> Result<(), ConnectError> {
//!         Ok(())
//!     }
//! }
//!
//! /// The clip queue's realtime side: one namespace per channel.
//! struct ClipQueue;
//! impl RealtimeModule for ClipQueue {
//!     const NAME: &'static str = "clips";
//!     type Handle = NamespaceRef<Clips>;
//!     fn register(self, sockets: &mut Sockets<'_>) -> Result<Self::Handle, RegisterError> {
//!         sockets.family(r"^\/clip\/\w+$", NamespaceOptions::default(), Clips)
//!     }
//! }
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
//! # runtime.block_on(async {
//! # let builder = dima_socketio::SocketIo::builder(
//! #     dima_socketio::Options::default(),
//! #     dima_socketio::Runtime::default(),
//! #     dima_core::Shutdown::new(),
//! # );
//! let mut registry = Registry::new(builder);
//! let clips = registry.register(ClipQueue)?;
//! let io = registry.build(&dima_web::ServeOptions::default())?;
//! assert_eq!(clips.emit("/clip/123", "clip", &[])?, 0); // nobody connected yet
//! # let _ = io;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! # })
//! # }
//! ```

use dima_socketio::{BuildError, Builder, Namespace, NamespaceOptions, NamespaceRef, SocketIo};
use std::fmt;

/// A realtime module of the API: a queue, a runtime or a group of overlay namespaces that owns
/// Socket.IO namespaces. Implemented by the modules of this crate (P4-RT-*); registered by the
/// API binary through [`Registry::register`].
pub trait RealtimeModule {
    /// The module's name in [`Declared::module`] and in errors (`tts`, `clips`, `pets`, …).
    const NAME: &'static str;

    /// What the module keeps once registered: the typed namespace handles it emits through, and
    /// whatever it built around them. The binary hands it to whoever drives the module (its
    /// routes, its loops).
    type Handle;

    /// Declares every namespace and family the module owns on `sockets`, once, at start-up,
    /// and returns the module's handle.
    fn register(self, sockets: &mut Sockets<'_>) -> Result<Self::Handle, RegisterError>;
}

/// One namespace or family a module declared.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    /// The module that declared it ([`RealtimeModule::NAME`]).
    pub module: &'static str,
    /// The static name (`/desktop`) or the family's pattern (`^\/clip\/\w+$`).
    pub name: String,
    /// Whether it is a family (a pattern) rather than one static namespace.
    pub family: bool,
}

/// Why a module could not register, or the server could not be built.
#[derive(Debug, thiserror::Error)]
pub enum RegisterError {
    /// The name or pattern was already declared by a module (possibly the same one).
    #[error("{module} declares {name:?}, which {owner} already declared")]
    Taken {
        /// The module that tried.
        module: &'static str,
        /// The name or pattern.
        name: String,
        /// The module that declared it first.
        owner: &'static str,
    },
    /// The Socket.IO builder refused a declaration (a bad name or pattern) or the server.
    #[error("{module}: {source}")]
    Build {
        /// The module that declared it, or `server` for [`Registry::build`].
        module: &'static str,
        /// The builder's reason.
        #[source]
        source: BuildError,
    },
    /// A module's own start-up failed while it registered.
    #[error("{module}: {message}")]
    Module {
        /// The module.
        module: &'static str,
        /// What failed (no secrets).
        message: String,
    },
}

/// What a module sees while it registers: the server's builder, tagged with the module's name so
/// every declaration is attributed.
pub struct Sockets<'r> {
    builder: &'r mut Builder,
    declared: &'r mut Vec<Declared>,
    module: &'static str,
}

impl fmt::Debug for Sockets<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Sockets")
            .field("module", &self.module)
            .finish_non_exhaustive()
    }
}

impl Sockets<'_> {
    /// `io.of("/name")`: a static namespace owned by this module.
    pub fn namespace<N: Namespace>(
        &mut self,
        name: &str,
        options: NamespaceOptions,
        handler: N,
    ) -> Result<NamespaceRef<N>, RegisterError> {
        self.claim(name, false)?;
        let handle = self
            .builder
            .namespace(name, options, handler)
            .map_err(|source| self.refused(source))?;
        self.record(name, false);
        Ok(handle)
    }

    /// `io.of(/^…$/)`: a family of namespaces named by an anchored pattern, owned by this
    /// module.
    pub fn family<N: Namespace>(
        &mut self,
        pattern: &str,
        options: NamespaceOptions,
        handler: N,
    ) -> Result<NamespaceRef<N>, RegisterError> {
        self.claim(pattern, true)?;
        let handle = self
            .builder
            .family(pattern, options, handler)
            .map_err(|source| self.refused(source))?;
        self.record(pattern, true);
        Ok(handle)
    }

    /// A module's own start-up failure, attributed to it.
    pub fn fail(&self, message: impl Into<String>) -> RegisterError {
        RegisterError::Module {
            module: self.module,
            message: message.into(),
        }
    }

    fn claim(&self, name: &str, family: bool) -> Result<(), RegisterError> {
        match self
            .declared
            .iter()
            .find(|known| known.name == name && known.family == family)
        {
            Some(known) => Err(RegisterError::Taken {
                module: self.module,
                name: name.to_owned(),
                owner: known.module,
            }),
            None => Ok(()),
        }
    }

    fn refused(&self, source: BuildError) -> RegisterError {
        RegisterError::Build {
            module: self.module,
            source,
        }
    }

    fn record(&mut self, name: &str, family: bool) {
        self.declared.push(Declared {
            module: self.module,
            name: name.to_owned(),
            family,
        });
    }
}

/// The registration of every realtime module, driven by the API binary.
pub struct Registry {
    builder: Builder,
    declared: Vec<Declared>,
}

impl fmt::Debug for Registry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Registry")
            .field("declared", &self.declared)
            .finish_non_exhaustive()
    }
}

impl Registry {
    /// A registry around the server's builder (made with the process's options, runtime and
    /// shutdown token: `dima_socketio::SocketIo::builder`).
    pub fn new(builder: Builder) -> Self {
        Self {
            builder,
            declared: Vec::new(),
        }
    }

    /// Lets `module` declare its namespaces and returns its handle.
    pub fn register<M: RealtimeModule>(&mut self, module: M) -> Result<M::Handle, RegisterError> {
        let mut sockets = Sockets {
            builder: &mut self.builder,
            declared: &mut self.declared,
            module: M::NAME,
        };
        module.register(&mut sockets)
    }

    /// Every namespace and family declared so far, in declaration order.
    pub fn declared(&self) -> &[Declared] {
        &self.declared
    }

    /// Builds the server for the `dima_web` server that will serve it (see
    /// `dima_socketio::Builder::build`). Must be called inside a Tokio runtime.
    pub fn build(self, serve: &dima_web::ServeOptions) -> Result<SocketIo, RegisterError> {
        self.builder
            .build(serve)
            .map_err(|source| RegisterError::Build {
                module: "server",
                source,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_socketio::{ConnectError, Handshake, Options, Runtime};
    use serde_json::json;

    struct Open;
    impl Namespace for Open {
        type Data = ();
        async fn check(&self, _: &Handshake, _: &str) -> Result<(), ConnectError> {
            Ok(())
        }
    }

    struct Overlays;
    impl RealtimeModule for Overlays {
        const NAME: &'static str = "overlays";
        type Handle = (NamespaceRef<Open>, NamespaceRef<Open>);
        fn register(self, sockets: &mut Sockets<'_>) -> Result<Self::Handle, RegisterError> {
            Ok((
                sockets.namespace("/desktop", NamespaceOptions::default(), Open)?,
                sockets.family(
                    r"^\/overlays\/triggers\/\w+$",
                    NamespaceOptions::default(),
                    Open,
                )?,
            ))
        }
    }

    struct Squatter(&'static str);
    impl RealtimeModule for Squatter {
        const NAME: &'static str = "squatter";
        type Handle = NamespaceRef<Open>;
        fn register(self, sockets: &mut Sockets<'_>) -> Result<Self::Handle, RegisterError> {
            sockets.namespace(self.0, NamespaceOptions::default(), Open)
        }
    }

    fn builder() -> Builder {
        dima_socketio::SocketIo::builder(
            Options::default(),
            Runtime::default(),
            dima_core::Shutdown::new(),
        )
    }

    #[tokio::test]
    async fn modules_declare_their_namespaces_and_keep_their_handles() {
        let mut registry = Registry::new(builder());
        let (desktop, triggers) = registry.register(Overlays).unwrap();
        assert_eq!(
            registry.declared(),
            [
                Declared {
                    module: "overlays",
                    name: "/desktop".into(),
                    family: false
                },
                Declared {
                    module: "overlays",
                    name: r"^\/overlays\/triggers\/\w+$".into(),
                    family: true
                },
            ]
        );
        let io = registry.build(&dima_web::ServeOptions::default()).unwrap();
        assert_eq!(
            desktop.emit("/desktop", "status", &[json!("ok")]).unwrap(),
            0
        );
        assert_eq!(
            triggers
                .emit(
                    "/overlays/triggers/123",
                    "trigger",
                    &[json!({"name": "wave"})]
                )
                .unwrap(),
            0
        );
        drop(io);
    }

    #[tokio::test]
    async fn a_name_has_one_owner() {
        let mut registry = Registry::new(builder());
        registry.register(Overlays).unwrap();
        let taken = registry.register(Squatter("/desktop")).unwrap_err();
        assert!(
            matches!(
                &taken,
                RegisterError::Taken { module: "squatter", name, owner: "overlays" } if name == "/desktop"
            ),
            "{taken}"
        );
        let bad = registry.register(Squatter("desktop")).unwrap_err();
        assert!(
            matches!(
                bad,
                RegisterError::Build {
                    module: "squatter",
                    source: BuildError::BadName(_)
                }
            ),
            "{bad}"
        );
        assert_eq!(registry.declared().len(), 2);
    }
}
