# Analysis sandbox for the AI assistant's run_python tool.
#
#   docker build -t vanflow-pysandbox:latest assets/sandbox
#
# Deliberately small. Every megabyte here is memory the on-prem box does not
# have: the reference install reported 1.87GB of container memory with 698MB
# already in use, which is why run_python ships DISABLED and this image is not
# pulled unless a site turns it on.
#
# No database driver is installed, on purpose. The sandbox never receives
# credentials and has no network, so a driver would be dead weight that also
# suggests a capability the design does not grant.
FROM python:3.12-slim

# --no-cache-dir keeps the layer down; these four cover the analysis the tool
# exists for — frames, arithmetic, charts, spreadsheets.
RUN pip install --no-cache-dir \
      pandas==2.2.3 \
      numpy==2.1.3 \
      matplotlib==3.9.2 \
      openpyxl==3.1.5

# matplotlib must not try to open a display, and must not write a font cache
# into a read-only root filesystem on first import.
ENV MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/mpl \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Non-root, so a container escape starts from an unprivileged account rather
# than from root. The uid matches nothing on the host by design.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox
USER sandbox

WORKDIR /job
