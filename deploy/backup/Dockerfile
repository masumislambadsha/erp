FROM alpine:3.20
RUN apk add --no-cache postgresql16-client aws-cli age tar gzip bash coreutils
COPY backup.sh /backup.sh
RUN chmod +x /backup.sh
ENTRYPOINT ["/backup.sh"]
CMD ["run"]
