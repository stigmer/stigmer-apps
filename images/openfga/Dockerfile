# The per-firm FGA engine image (project DD-003 D1): upstream OpenFGA
# with exactly two additions the live deployment platform cannot express
# otherwise —
#
#   1. a COMMAND: the upstream image is distroless with ENTRYPOINT
#      ["/openfga"] and NO default CMD, and the platform's deployed
#      KubernetesDeployment API offers no command/args fields (verified
#      against a live install failure), so "what to run" must be baked
#      into the image;
#   2. MIGRATE-THEN-RUN: the platform models no init containers, so the
#      schema migration runs at container start. `openfga migrate` is
#      idempotent and lock-serialized server-side — concurrent replicas
#      and restarts are safe.
#
# Everything else — datastore, preshared-key authentication (mandatory:
# engine endpoints share cluster networks with agent sandboxes), ports —
# arrives through OPENFGA_* environment variables from the firm chart.
#
# The upstream base is distroless (no shell), so a static busybox is
# copied in solely to sequence the two commands. Bases are pinned; bump
# both deliberately, alongside the commons test harness's engine pin
# (@stigmer/authorization testing) and the chart's openfga_image_tag.
FROM public.ecr.aws/docker/library/busybox:1.37.0-musl AS shell

FROM openfga/openfga:v1.18.3

COPY --from=shell /bin/busybox /bin/busybox

ENTRYPOINT ["/bin/busybox", "sh", "-c", "/openfga migrate && exec /openfga run"]
